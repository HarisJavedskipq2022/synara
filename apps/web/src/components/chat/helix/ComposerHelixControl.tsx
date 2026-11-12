// FILE: ComposerHelixControl.tsx
// Purpose: The one Helix control in the composer's picker row, on new and existing
//          chats alike. Off, it is a compact "Helix" button: one click turns Helix on
//          with the last Builder the user chose. On, a pill names the Builder and opens a
//          popover with the Builder's model and effort and "Turn off Helix". Every change
//          is held by the composer and rides on the next message (the server applies it
//          before that turn, or once the Builder finishes). With the `enableHelix` setting
//          off, the button stays and its popover offers to turn the setting on.
// Layer: Chat Helix UI
// Exports: ComposerHelixControl

import type { ModelSelection, ThreadId } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useTranslation } from "~/i18n";
import {
  clearHelixDraftChoice,
  defaultHelixBuilder,
  readRememberedHelixBuilder,
  setHelixDraftChoice,
  useHelixDraftStore,
} from "~/helix/helixDraftStore";
import { updateHelixSetting } from "~/helix/helixSettings";
import { useHelixStore } from "~/helix/helixStore";
import { loadHelixCapabilities, refreshHelixLeadDetail } from "~/helix/helixSync";
import { useHelixLeadDetail, useHelixLeadSummary } from "~/helix/useHelix";
import { deleteArchivedThreadsFromClient } from "~/lib/archivedThreadDelete";
import { HandoffIcon } from "~/lib/icons";
import { serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { toastManager } from "../../ui/toast";
import { GroupEffortRow, GroupModelRow } from "../group/GroupModelEffortRow";
import { modelSelectionsEqual } from "../group/groupSettingsDialog.logic";
import { PickerTriggerButton } from "../PickerTriggerButton";
import {
  resolveComposerHelixControl,
  type ComposerHelixControlView,
} from "./composerHelixControl.logic";
import { closeHelixControl, openHelixControl, useHelixControlStore } from "./helixControlStore";
import { helixProviderRestrictions } from "./helixProviderRestrictions";
import { useHelixLeadEligible } from "./useHelixLeadEligible";

function selectEnableHelix(settings: { readonly enableHelix?: boolean }): boolean {
  return settings.enableHelix === true;
}

export function ComposerHelixControl(props: {
  threadId: ThreadId;
  /** The model the next message goes with: the Lead's provider must be able to lead. */
  leadSelection: ModelSelection | null;
  projectCwd: string;
  compact?: boolean;
  hideLabel?: boolean;
  /** Present while the chat has not started on a local checkout: turning Helix on moves it to a new worktree. */
  onPreferWorktree?: (() => void) | undefined;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { threadId } = props;
  const supported = useHelixStore((state) => state.supported && state.messagePairingSupported);
  const eligible = useHelixLeadEligible(threadId);
  if (!supported || !eligible) return null;
  return <ComposerHelixControlBody {...props} />;
}

function ComposerHelixControlBody({
  threadId,
  leadSelection,
  projectCwd,
  compact,
  hideLabel,
  onPreferWorktree,
  onOpenThread,
}: {
  threadId: ThreadId;
  leadSelection: ModelSelection | null;
  projectCwd: string;
  compact?: boolean;
  hideLabel?: boolean;
  onPreferWorktree?: (() => void) | undefined;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settingQuery = useQuery({ ...serverSettingsQueryOptions(), select: selectEnableHelix });
  const settingOn = settingQuery.data === true;
  const summary = useHelixLeadSummary(threadId);
  const detail = useHelixLeadDetail(summary ? threadId : null);
  const capabilities = useHelixStore((state) => state.capabilities);
  const choice = useHelixDraftStore((state) => state.choiceByThreadId.get(threadId));
  const open = useHelixControlStore((state) => state.threadId === threadId);
  const [settingBusy, setSettingBusy] = useState(false);

  useEffect(() => {
    if (settingOn) void loadHelixCapabilities();
  }, [settingOn]);

  const control = resolveComposerHelixControl({
    settingOn,
    summary,
    view: detail.view,
    choice,
  });
  const { pairActive, configuredBuilder, pendingChange, label, change } = control;
  // The pair a choice is made against: a choice for a pair that is later replaced is dropped.
  const choiceBasis = { pairId: summary?.pairId ?? null };
  const state = control;
  const builderRestrictions = helixProviderRestrictions(capabilities, "builder");
  const leadRestriction = leadSelection
    ? helixProviderRestrictions(capabilities, "lead")[leadSelection.provider]
    : undefined;
  // Back to what the pair already is, with nothing pending: there is no change to send.
  const isPairAsIs = (builder: ModelSelection) =>
    pairActive &&
    pendingChange === null &&
    configuredBuilder !== null &&
    modelSelectionsEqual(builder, configuredBuilder);

  const turnOn = (builder: ModelSelection) => {
    if (isPairAsIs(builder)) {
      clearHelixDraftChoice(threadId);
      return;
    }
    setHelixDraftChoice(threadId, { enabled: true, builderModelSelection: builder }, choiceBasis);
    onPreferWorktree?.();
  };
  // Turning a pair back on (after "Turn off" in this draft) keeps its own Builder.
  const oneClickBuilder = () =>
    defaultHelixBuilder({
      remembered: (pairActive ? configuredBuilder : null) ?? readRememberedHelixBuilder(),
      chatSelection: leadSelection,
      restrictions: builderRestrictions,
    });

  const onOpenChange = (next: boolean) => {
    if (!next) {
      closeHelixControl();
      return;
    }
    // Off: one click turns Helix on with the remembered Builder; the popover opens only
    // when something needs saying (setting off, a Lead that cannot lead, no Builder, or
    // an unsent "turn off" the user may want to take back).
    if (!state.on && change === "none" && settingOn && leadRestriction === undefined) {
      const builder = oneClickBuilder();
      if (builder) {
        turnOn(builder);
        return;
      }
    }
    openHelixControl(threadId);
  };

  const chooseBuilder = (builder: ModelSelection) => {
    if (isPairAsIs(builder)) {
      clearHelixDraftChoice(threadId);
      return;
    }
    setHelixDraftChoice(threadId, { enabled: true, builderModelSelection: builder }, choiceBasis);
  };

  const turnOff = () => {
    closeHelixControl();
    if (pairActive || pendingChange !== null) {
      setHelixDraftChoice(threadId, { enabled: false }, choiceBasis);
    } else {
      clearHelixDraftChoice(threadId);
    }
  };

  const enableSetting = () => {
    if (settingBusy) return;
    setSettingBusy(true);
    void updateHelixSetting(queryClient, true)
      .then((saved) => {
        if (!saved) return;
        void loadHelixCapabilities();
        // Continue what the click asked for: turn Helix on for this chat.
        const builder = oneClickBuilder();
        if (builder && leadRestriction === undefined && !pairActive) turnOn(builder);
      })
      .finally(() => setSettingBusy(false));
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <PickerTriggerButton
            icon={<HandoffIcon aria-hidden="true" className="size-3.5" />}
            label={label}
            compact={compact ?? false}
            hideLabel={hideLabel ?? false}
            hideChevron={!state.on && change === "none"}
            data-testid="composer-helix-control"
            data-helix-on={state.on ? "" : undefined}
            data-helix-change={change === "none" ? undefined : change}
            aria-label={control.ariaLabel}
            title={!state.on && change === "none" ? t("chat:helix_controlOffTitle") : undefined}
            className={cn(state.pending && "text-muted-foreground")}
          />
        }
      />
      <PopoverPopup
        side="top"
        align="end"
        sideOffset={6}
        className="w-80 [&_[data-slot=popover-viewport]]:p-1"
        data-testid="composer-helix-popover"
      >
        <div className="flex flex-col">
          <div className="px-2 pt-1.5 pb-1">
            <p className="text-ui font-medium text-foreground">{t("chat:helix_name")}</p>
            <p className="text-ui-sm text-muted-foreground">{t("chat:helix_controlDescription")}</p>
          </div>
          {!settingOn ? (
            <div className="space-y-2 px-2 pt-1 pb-1.5" data-testid="composer-helix-setting-off">
              <p className="text-ui-sm text-muted-foreground">
                {t("chat:helix_controlSettingOff")}
              </p>
              <Button
                type="button"
                size="sm"
                className="w-full"
                disabled={settingBusy || settingQuery.data === undefined}
                onClick={enableSetting}
              >
                {t("chat:helix_turnOn")}
              </Button>
            </div>
          ) : (
            <>
              {leadRestriction !== undefined ? (
                <p role="alert" className="px-2 py-1 text-ui-sm text-muted-foreground">
                  {t("chat:helix_leadUnsupported", { value0: leadRestriction })}
                </p>
              ) : null}
              {state.on && state.builder ? (
                <div className="py-0.5">
                  <GroupModelRow
                    layout="inline"
                    title={t("chat:helix_builder")}
                    description={t("chat:helix_builderModelDescription")}
                    selection={state.builder}
                    defaultSelection={null}
                    projectCwd={projectCwd}
                    providerRestrictions={builderRestrictions}
                    onChange={chooseBuilder}
                  />
                  <GroupEffortRow
                    layout="inline"
                    title={t("chat:helix_effort")}
                    description={t("chat:helix_builderEffortDescription")}
                    selection={state.builder}
                    projectCwd={projectCwd}
                    onChange={chooseBuilder}
                  />
                  {change === "builder" ? (
                    <HelixKeepBuilderButton
                      builderName={control.currentBuilderName}
                      onClick={() => clearHelixDraftChoice(threadId)}
                    />
                  ) : null}
                </div>
              ) : state.on && detail.status === "error" ? (
                <div
                  role="alert"
                  className="flex items-center gap-2 px-2 py-1 text-ui-sm text-muted-foreground"
                >
                  <span className="min-w-0 flex-1">{t("chat:helix_loadFailed")}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => void refreshHelixLeadDetail(threadId)}
                  >
                    {t("chat:helix_retry")}
                  </Button>
                </div>
              ) : state.on ? (
                <p role="status" className="px-2 py-1 text-ui-sm text-muted-foreground">
                  {t("chat:helix_loading")}
                </p>
              ) : null}
              <HelixControlNotes
                touched={state.touched}
                pending={state.pending}
                on={state.on}
                pairActive={pairActive}
                limits={detail.view?.pair.config.limits ?? capabilities?.defaultLimits ?? null}
              />
              {!state.on && summary?.lifecycle === "disabled" ? (
                <HelixBuilderTranscriptRow
                  leadThreadId={threadId}
                  builderThreadId={summary.builderThreadId}
                  builderExists={detail.view?.pair.builderCreatedAt != null}
                  onOpenThread={(id) => {
                    closeHelixControl();
                    onOpenThread(id);
                  }}
                />
              ) : null}
              <HelixControlFooter
                change={change}
                on={state.on}
                turnOnDisabled={leadRestriction !== undefined || oneClickBuilder() === null}
                onKeepOn={() => clearHelixDraftChoice(threadId)}
                onTurnOff={turnOff}
                onTurnOn={() => {
                  const builder = oneClickBuilder();
                  if (builder) turnOn(builder);
                }}
              />
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Take back an unsent Builder change: the pair keeps its own Builder. */
export function HelixKeepBuilderButton({
  builderName,
  onClick,
}: {
  builderName: string | null;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="w-full justify-start px-2 text-ui"
      data-testid="composer-helix-keep-builder"
      onClick={onClick}
    >
      {t("chat:helix_keepBuilder", { value0: builderName ?? t("chat:helix_currentBuilder") })}
    </Button>
  );
}

/**
 * The popover's last row: "Keep Helix on" takes back an unsent turn-off, "Turn off
 * Helix" while it is on, "Turn on Helix" otherwise.
 */
export function HelixControlFooter({
  change,
  on,
  turnOnDisabled,
  onKeepOn,
  onTurnOff,
  onTurnOn,
}: {
  change: ComposerHelixControlView["change"];
  on: boolean;
  turnOnDisabled: boolean;
  onKeepOn: () => void;
  onTurnOff: () => void;
  onTurnOn: () => void;
}) {
  const { t } = useTranslation();
  const [label, testId, onClick, disabled] =
    change === "turn-off"
      ? [t("chat:helix_keepOn"), "composer-helix-keep-on", onKeepOn, false]
      : on
        ? [t("chat:helix_turnOff"), "composer-helix-turn-off", onTurnOff, false]
        : [t("chat:helix_turnOn"), "composer-helix-turn-on", onTurnOn, turnOnDisabled];
  return (
    <div className="mt-1 border-t border-[color:var(--color-border-light)] pt-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full justify-start px-2 text-ui"
        data-testid={testId}
        disabled={disabled}
        onClick={onClick}
      >
        {label}
      </Button>
    </div>
  );
}

function HelixControlNotes({
  touched,
  pending,
  on,
  pairActive,
  limits,
}: {
  touched: boolean;
  pending: boolean;
  on: boolean;
  pairActive: boolean;
  limits: { maxCorrectionsPerWorkItem: number; maxDispatchesPerGoal: number } | null;
}) {
  const { t } = useTranslation();
  const lines: string[] = [];
  if (pending) lines.push(t("chat:helix_pendingChange"));
  else if (touched) {
    lines.push(
      on
        ? pairActive
          ? t("chat:helix_choiceChangesWithMessage")
          : t("chat:helix_choiceOnWithMessage")
        : t("chat:helix_choiceOffWithMessage"),
    );
  }
  if (on && limits) {
    lines.push(
      t("chat:helix_limits", {
        value0: limits.maxCorrectionsPerWorkItem,
        value1: limits.maxDispatchesPerGoal,
      }),
    );
  }
  if (lines.length === 0) return null;
  return (
    <div className="space-y-0.5 px-2 py-1 text-ui-sm text-muted-foreground">
      {lines.map((line, index) => (
        <p
          key={line}
          role={index === 0 && (pending || touched) ? "status" : undefined}
          data-testid={index === 0 && pending ? "composer-helix-pending" : undefined}
        >
          {line}
        </p>
      ))}
    </div>
  );
}

/** A turned-off pair keeps its Builder (archived) until the user deletes it. */
function HelixBuilderTranscriptRow({
  leadThreadId,
  builderThreadId,
  builderExists,
  onOpenThread,
}: {
  leadThreadId: ThreadId;
  builderThreadId: ThreadId;
  builderExists: boolean;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const removeDeletedThreadFromClientState = useStore(
    (state) => state.removeDeletedThreadFromClientState,
  );
  if (!builderExists) return null;
  const deleteBuilder = () => {
    const api = readNativeApi();
    if (!api || busy) return;
    setBusy(true);
    void api.dialogs
      .confirm(t("chat:helix_deleteBuilderConfirm"))
      .then(async (confirmed) => {
        if (!confirmed) return;
        await deleteArchivedThreadsFromClient({
          api: api.orchestration,
          threadIds: [builderThreadId],
          removeDeletedThreadFromClientState,
        });
        // The server clears `builderCreatedAt` (and names a new Builder id) once deleted.
        await refreshHelixLeadDetail(leadThreadId);
      })
      .catch((cause: unknown) => {
        toastManager.add({
          type: "error",
          title: t("chat:helix_couldNotDeleteBuilder"),
          description: cause instanceof Error ? cause.message : undefined,
        });
      })
      .finally(() => setBusy(false));
  };
  return (
    <div
      className="flex min-h-8 items-center justify-between gap-2 px-2 py-0.5"
      data-testid="composer-helix-builder-transcript"
    >
      <span
        className="min-w-0 truncate text-ui text-muted-foreground"
        title={t("chat:helix_builderTranscriptDescription")}
      >
        {t("chat:helix_builderTranscript")}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={busy}
          aria-label={t("chat:helix_openBuilderAria")}
          onClick={() => onOpenThread(builderThreadId)}
        >
          {t("chat:helix_openBuilderShort")}
        </Button>
        <Button
          type="button"
          variant="destructive-outline"
          size="xs"
          disabled={busy}
          onClick={deleteBuilder}
        >
          {t("chat:helix_deleteBuilder")}
        </Button>
      </span>
    </div>
  );
}
