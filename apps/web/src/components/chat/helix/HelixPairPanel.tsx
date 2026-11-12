// FILE: HelixPairPanel.tsx
// Purpose: The Helix panel a Lead chat's capsule opens: pair status with Pause, Resume
//          and Stop, the hold and what releases it, the Builder's live activity with a
//          link to its transcript, the goal's dispatch budget, and the handoff cards.
// Layer: Chat Helix UI
// Exports: HelixPairPanel, HelixBuilderActivity

import type { HelixPairSummary, HelixPairView, ThreadId } from "@synara/contracts";
import { useState } from "react";

import { useTranslation } from "~/i18n";
import { helixErrorMessageKey } from "~/helix/helixErrors";
import {
  canPauseHelixPair,
  canResumeHelixPair,
  canStopHelixPair,
  helixChatStatusLabelKey,
  isHelixChatStatusAttention,
  isHelixChatStatusLive,
  helixHoldHandoffState,
  isHelixBuilderRunning,
  type HelixChatStatus,
} from "~/helix/helixPresentation";
import {
  pauseHelixPair,
  resumeHelixPair,
  stopHelixPair,
  type HelixMutationResult,
} from "~/helix/helixActions";
import { clearPendingHelixTurnOff } from "~/helix/helixDraftStore";
import type { HelixLeadDetail } from "~/helix/helixStore";
import { refreshHelixLeadDetail } from "~/helix/helixSync";
import {
  HandoffIcon,
  ArrowUpRightIcon,
  HammerIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { formatProviderModelOptionName } from "~/providerModelOptions";
import { useStore } from "~/store";
import { isThreadActivelyWorking } from "../../Sidebar.logic";
import { ProviderIcon } from "../../ProviderIcon";
import { Button } from "../../ui/button";
import { LiveStatusSpinner } from "../../ui/spinner";
import {
  ComposerStackedPanelHeaderRow,
  ComposerStackedPanelRowLabel,
  ComposerStackedPanelRowMain,
} from "../ComposerStackedPanelContent";
import {
  COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
} from "../composerStackedPanelStyles";
import { HelixHandoffCard } from "./HelixHandoffCard";
import { helixHoldCopy } from "./helixHoldCopy";
import { helixToneClassName } from "./helixTone";

/** The panel opens above the capsule in a shared popover: bound it to the space the
 *  popover has (Base UI's `--available-height`) and scroll its body, so it never runs
 *  past the top of a short window. Header and actions stay in view. */
const HELIX_PANEL_CLASS_NAME =
  "flex max-h-[min(40rem,calc(var(--available-height,100dvh)-0.5rem))] min-h-0 flex-col";

export function helixStatusToneClassName(status: HelixChatStatus): string {
  if (isHelixChatStatusLive(status)) return helixToneClassName("live");
  if (isHelixChatStatusAttention(status)) return helixToneClassName("warning");
  if (status === "stopped" || status === "paused") return helixToneClassName("warning");
  return helixToneClassName("muted");
}

type BuilderActivityKind = "notStarted" | "waitingApproval" | "waitingInput" | "working" | "idle";

const BUILDER_ACTIVITY_LABEL_KEYS: Readonly<Record<BuilderActivityKind, string>> = {
  notStarted: "chat:helix_builderNotStarted",
  waitingApproval: "chat:helix_builderWaitingApproval",
  waitingInput: "chat:helix_builderWaitingInput",
  working: "chat:helix_builderWorking",
  idle: "chat:helix_builderIdle",
};

/** The Builder's live status, its model and a link to its full transcript. */
export function HelixBuilderActivity({
  builderThreadId,
  builderCreatedAt,
  view,
  onOpenThread,
}: {
  builderThreadId: ThreadId;
  builderCreatedAt: string | null;
  view: HelixPairView | null;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { t } = useTranslation();
  const builder = useStore((state) => state.sidebarThreadSummaryById[builderThreadId]);
  const kind: BuilderActivityKind =
    builder === undefined && builderCreatedAt === null
      ? "notStarted"
      : builder?.hasPendingApprovals
        ? "waitingApproval"
        : builder?.hasPendingUserInput
          ? "waitingInput"
          : builder && isThreadActivelyWorking(builder)
            ? "working"
            : "idle";
  const selection = view?.pair.config.builderModelSelection ?? null;
  const modelLabel = selection
    ? formatProviderModelOptionName({ provider: selection.provider, slug: selection.model })
    : null;
  const canOpen = builder !== undefined || builderCreatedAt !== null;
  return (
    <div
      data-testid="helix-builder-activity"
      className="flex min-w-0 items-center gap-1.5 py-1 text-ui-sm"
    >
      {kind === "working" ? (
        <LiveStatusSpinner className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
      ) : (
        <HammerIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} aria-hidden="true" />
      )}
      <span className="shrink-0 font-medium text-foreground/80">{t("chat:helix_builder")}</span>
      {selection && modelLabel ? (
        <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
          <ProviderIcon provider={selection.provider} className="size-3 shrink-0" />
          <span className="truncate">{modelLabel}</span>
        </span>
      ) : null}
      <span aria-hidden="true" className="text-muted-foreground/60">
        ·
      </span>
      <span
        className={cn(
          "shrink-0",
          kind === "working"
            ? helixToneClassName("live")
            : kind === "waitingApproval" || kind === "waitingInput"
              ? helixToneClassName("warning")
              : "text-muted-foreground",
        )}
      >
        {t(BUILDER_ACTIVITY_LABEL_KEYS[kind])}
      </span>
      {canOpen ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="ms-auto h-5 shrink-0 gap-1 px-1.5 text-ui-sm text-muted-foreground hover:text-foreground"
          onClick={() => onOpenThread(builderThreadId)}
        >
          {t("chat:helix_openBuilderTranscript")}
          <ArrowUpRightIcon className="size-3" aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

type ControlAction = "pause" | "resume" | "stop";

export function HelixPairPanel({
  pendingOff,
  summary,
  detail,
  status,
  running,
  focusHandoffId,
  onOpenThread,
  onChangeBuilder,
}: {
  /** The composer holds an unsent "turn off" for this chat. */
  pendingOff?: boolean;
  summary: HelixPairSummary;
  detail: HelixLeadDetail;
  status: HelixChatStatus;
  /** An agent is running now: spinner instead of the Helix glyph. */
  running: boolean;
  /** A handoff opened from the Lead's timeline: expanded and scrolled into view. */
  focusHandoffId: string | null;
  onOpenThread: (threadId: ThreadId) => void;
  /** Opens the composer's Helix control, where Builder changes ride on the next message. */
  onChangeBuilder: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<ControlAction | null>(null);
  const view = detail.view;
  const pair = view?.pair ?? null;
  const hold = summary.hold;

  const run = (action: ControlAction, mutation: () => Promise<HelixMutationResult>) => {
    if (busy !== null) return;
    setBusy(action);
    void mutation().finally(() => setBusy(null));
  };

  const limits = pair?.config.limits ?? null;
  const goal = pair?.goal ?? null;
  const holdCopy = hold
    ? helixHoldCopy(hold, {
        holdHandoffState: helixHoldHandoffState(summary, view?.handoffs ?? null),
        builderRunning: isHelixBuilderRunning(summary),
        maxDispatchesPerGoal: limits?.maxDispatchesPerGoal ?? null,
      })
    : null;
  const focusIndex = view
    ? view.handoffs.findIndex((handoff) => handoff.id === focusHandoffId)
    : -1;
  const expandedIndex = focusIndex === -1 ? 0 : focusIndex;

  return (
    <div data-testid="helix-pair-panel" className={HELIX_PANEL_CLASS_NAME}>
      <ComposerStackedPanelHeaderRow className="shrink-0">
        <ComposerStackedPanelRowMain>
          {running ? (
            <LiveStatusSpinner className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          ) : (
            <HandoffIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} aria-hidden="true" />
          )}
          <ComposerStackedPanelRowLabel tone="meta">
            <span className="font-medium text-foreground/80">{t("chat:helix_name")}</span>
            <span className={cn("ml-1.5", helixStatusToneClassName(status))}>
              {t(helixChatStatusLabelKey(status))}
            </span>
            {goal && goal.dispatchBudget > 0 ? (
              <span className="ml-1.5 tabular-nums">
                {t("chat:helix_dispatchBudget", {
                  value0: goal.dispatchCount,
                  value1: goal.dispatchBudget,
                })}
              </span>
            ) : null}
          </ComposerStackedPanelRowLabel>
        </ComposerStackedPanelRowMain>
        <div className="flex shrink-0 items-center gap-0.5">
          {canResumeHelixPair(summary) ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
              disabled={busy !== null}
              onClick={() => {
                // Resume means "keep going": it also takes back an unsent "turn off".
                clearPendingHelixTurnOff(summary.leadThreadId);
                run("resume", () => resumeHelixPair(summary));
              }}
              aria-label={t("chat:helix_resumeAria")}
              title={t("chat:helix_resume")}
            >
              <PlayIcon className="size-3" />
            </Button>
          ) : null}
          {canPauseHelixPair(summary) ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
              disabled={busy !== null}
              onClick={() => run("pause", () => pauseHelixPair(summary))}
              aria-label={t("chat:helix_pauseAria")}
              title={t("chat:helix_pause")}
            >
              <PauseIcon className="size-3" />
            </Button>
          ) : null}
          {canStopHelixPair(summary) ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME}
              disabled={busy === "stop"}
              onClick={() => run("stop", () => stopHelixPair(summary))}
              aria-label={t("chat:helix_stopAria")}
              title={t("chat:helix_stop")}
            >
              <StopIcon className="size-3" />
            </Button>
          ) : null}
        </div>
      </ComposerStackedPanelHeaderRow>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-y-auto overscroll-contain",
          COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
        )}
      >
        <p className="text-ui-sm text-muted-foreground">{t("chat:helix_panelSubtitle")}</p>
        {pendingOff === true ? (
          <p className="text-ui-sm text-muted-foreground" data-testid="helix-panel-pending-off">
            {t("chat:helix_pendingOffNote")}
          </p>
        ) : null}
        {holdCopy ? (
          <div
            role="status"
            data-testid="helix-hold"
            className="mt-1.5 rounded-lg border border-[color:var(--color-border-light)] bg-[var(--sidebar-accent)]/40 px-2.5 py-1.5 text-ui-sm"
          >
            <p className="font-medium text-foreground/85">{holdCopy.title}</p>
            {holdCopy.release ? (
              <p className="mt-0.5 text-muted-foreground">{holdCopy.release}</p>
            ) : null}
          </div>
        ) : null}

        <HelixBuilderActivity
          builderThreadId={summary.builderThreadId}
          builderCreatedAt={pair?.builderCreatedAt ?? null}
          view={view}
          onOpenThread={onOpenThread}
        />

        <div className="flex min-w-0 items-center gap-2 pt-1 pb-0.5">
          <span className="text-ui-xs font-medium text-muted-foreground/70">
            {t("chat:helix_handoffs")}
          </span>
        </div>
        {detail.status === "error" && !view ? (
          <div
            role="alert"
            className="flex items-center gap-2 py-1 text-ui-sm text-muted-foreground"
          >
            <span className="min-w-0 flex-1">
              {t("chat:helix_loadFailed")}{" "}
              {detail.error ? t(helixErrorMessageKey(detail.error)) : null}
            </span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => void refreshHelixLeadDetail(summary.leadThreadId)}
            >
              {t("chat:helix_retry")}
            </Button>
          </div>
        ) : !view ? (
          <div
            role="status"
            className="flex items-center gap-1.5 py-1 text-ui-sm text-muted-foreground"
          >
            <LiveStatusSpinner className="size-3" />
            {t("chat:helix_loading")}
          </div>
        ) : view.handoffs.length === 0 ? (
          <p className="py-1 text-ui-sm text-muted-foreground/70">{t("chat:helix_noHandoffs")}</p>
        ) : (
          <div className="space-y-1.5 pb-1">
            {view.handoffs.map((handoff, index) => (
              <HelixHandoffCard
                key={handoff.id}
                handoff={handoff}
                pairHold={hold}
                defaultExpanded={index === expandedIndex}
                focused={handoff.id === focusHandoffId}
              />
            ))}
          </div>
        )}
      </div>

      <div className={COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-[color:var(--color-border-light)] pt-1.5">
          {limits ? (
            <span className="min-w-0 flex-1 text-ui-xs text-muted-foreground/70">
              {t("chat:helix_limits", {
                value0: limits.maxCorrectionsPerWorkItem,
                value1: limits.maxDispatchesPerGoal,
              })}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="h-6 px-2 text-ui-sm"
            onClick={onChangeBuilder}
          >
            {t("chat:helix_changeBuilder")}
          </Button>
        </div>
      </div>
    </div>
  );
}
