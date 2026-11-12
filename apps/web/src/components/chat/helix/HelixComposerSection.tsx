// FILE: HelixComposerSection.tsx
// Purpose: Everything Helix places around a chat's composer. In a Lead chat: the pair
//          status capsule (opens the Helix panel), the at-a-glance Helix line (Builder
//          step, waits, holds with Resume), the note when a message's Helix change was not
//          applied, and the Builder's approval and question requests, answerable here. In a Builder
//          transcript: the "Builder for <Lead>" notice and the composer lock. Each piece
//          reads Helix state through narrow selectors and renders nothing for a chat
//          without a pair or while Helix is off.
// Layer: Chat Helix UI
// Exports: HelixComposerCapsule, HelixComposerNotices, useHelixBuilderComposerLock

import type {
  ApprovalRequestId,
  HelixPairSummary,
  HelixQuarantinedPair,
  ProviderInteractionMode,
  ThreadId,
} from "@synara/contracts";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useTranslation } from "~/i18n";
import { removeHelixPair } from "~/helix/helixActions";
import {
  helixChatStatusLabelKey,
  isHelixChatStatusRunning,
  resolveHelixChatStatus,
  type HelixChatStatus,
} from "~/helix/helixPresentation";
import {
  useHelixBuilderLeadThreadId,
  useHelixEnabled,
  useHelixLeadDetail,
  useHelixLeadSummary,
} from "~/helix/useHelix";
import { useHelixDraftStore } from "~/helix/helixDraftStore";
import { useHelixStore } from "~/helix/helixStore";
import {
  ArrowUpRightIcon,
  BackToParentIcon,
  HandoffIcon,
  InfoIcon,
  TriangleAlertIcon,
} from "~/lib/icons";
import { cn, newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../../pendingUserInput";
import {
  canSessionAnswerPendingRequests,
  derivePendingUserInputs,
  type PendingUserInput,
} from "../../../session-logic";
import { useStore } from "../../../store";
import { createThreadSelector } from "../../../storeSelectors";
import { retainThreadDetailSubscription } from "../../../threadDetailSubscriptionRetention";
import {
  buildThreadSubscribeInput,
  clearThreadDetailResumeCursor,
} from "../../../threadDetailResumeCursors";
import { isThreadActivelyWorking } from "../../Sidebar.logic";
import { Button } from "../../ui/button";
import { LiveStatusSpinner } from "../../ui/spinner";
import { Textarea } from "../../ui/textarea";
import {
  COMPOSER_CAPSULE_ACTION_CLASS_NAME,
  ComposerCapsule,
  ComposerCapsulePopover,
} from "../ComposerCapsule";
import { toastManager } from "../../ui/toast";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "../composerStackedPanelStyles";
import { HubPendingApprovals } from "../group/HubPendingApprovals";
import { UserInputQuestionForm } from "../UserInputQuestionForm";
import {
  HELIX_BUILDER_REQUESTS_ATTRIBUTE,
  HelixActivityBanner,
  HelixPairingNoteBanner,
} from "./HelixActivityBanner";
import { HelixPairPanel, helixStatusToneClassName } from "./HelixPairPanel";
import { closeHelixPanel, openHelixPanel, useHelixPanelStore } from "./helixPanelStore";
import { openHelixControl } from "./helixControlStore";

function useLeadWorking(threadId: ThreadId): boolean {
  return useStore((state) => {
    const thread = state.sidebarThreadSummaryById[threadId];
    return thread ? isThreadActivelyWorking(thread) : false;
  });
}

function activePairSummary(summary: HelixPairSummary | null): HelixPairSummary | null {
  return summary?.lifecycle === "active" ? summary : null;
}

/** The Lead chat's pair status capsule; opens the full Helix panel. */
export function HelixComposerCapsule({
  threadId,
  interactionMode,
  onOpenThread,
}: {
  threadId: ThreadId;
  /** The Lead's composer mode: in plan mode the Lead cannot delegate. */
  interactionMode: ProviderInteractionMode;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { t } = useTranslation();
  const enabled = useHelixEnabled();
  const rawSummary = activePairSummary(useHelixLeadSummary(threadId));
  const summary = enabled ? rawSummary : null;
  const detail = useHelixLeadDetail(summary ? threadId : null);
  const leadWorking = useLeadWorking(threadId);
  // An unsent "turn off" in this chat's composer: say so here too, so the two agree.
  const pendingOff = useHelixDraftStore(
    (state) => state.choiceByThreadId.get(threadId)?.enabled === false,
  );
  const panelOpen = useHelixPanelStore((state) => state.threadId === threadId);
  const focusHandoffId = useHelixPanelStore((state) =>
    state.threadId === threadId ? state.focusHandoffId : null,
  );
  // With the setting off the server holds the pair like Pause, but a Builder turn already
  // running finishes. Say so, and let the user open or stop it: nothing else renders.
  const offBuilderThreadId = !enabled && rawSummary !== null ? rawSummary.builderThreadId : null;
  const offBuilderWorking = useStore((state) => {
    if (offBuilderThreadId === null) return false;
    const builder = state.sidebarThreadSummaryById[offBuilderThreadId];
    return builder ? isThreadActivelyWorking(builder) : false;
  });
  if (offBuilderThreadId !== null && offBuilderWorking) {
    return (
      <HelixOffBuilderCapsule builderThreadId={offBuilderThreadId} onOpenThread={onOpenThread} />
    );
  }
  if (!summary) return null;
  const status = resolveHelixChatStatus({
    summary,
    leadWorking,
    latestState: detail.view?.handoffs[0]?.state ?? summary.latestHandoffState ?? null,
  });
  if (status === null) return null;
  return (
    <>
      <ComposerCapsulePopover
        open={panelOpen}
        onOpenChange={(next) => (next ? openHelixPanel(threadId) : closeHelixPanel())}
        icon={
          isHelixChatStatusRunning(status, leadWorking) ? (
            <LiveStatusSpinner className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          ) : (
            <HandoffIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} aria-hidden="true" />
          )
        }
        label={<HelixCapsuleLabel status={status} pendingOff={pendingOff} />}
        title={t("chat:helix_capsuleTitle")}
        testId="helix-capsule"
        popupTestId="helix-panel-popup"
      >
        {(close) => (
          <HelixPairPanel
            pendingOff={pendingOff}
            summary={summary}
            detail={detail}
            status={status}
            running={isHelixChatStatusRunning(status, leadWorking)}
            focusHandoffId={focusHandoffId}
            onOpenThread={(id) => {
              close();
              onOpenThread(id);
            }}
            onChangeBuilder={() => {
              close();
              openHelixControl(threadId);
            }}
          />
        )}
      </ComposerCapsulePopover>
      {interactionMode === "plan" ? (
        <ComposerCapsule
          icon={<InfoIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} aria-hidden="true" />}
          title={t("chat:helix_planModeNote")}
          role="note"
          testId="helix-plan-mode-note"
        >
          <span aria-label={t("chat:helix_planModeNote")}>{t("chat:helix_planModeCapsule")}</span>
        </ComposerCapsule>
      ) : null}
    </>
  );
}

/** "Helix <status>", plus the composer's unsent "turn off" so the two never disagree. */
export function HelixCapsuleLabel({
  status,
  pendingOff,
}: {
  status: HelixChatStatus;
  pendingOff: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {t("chat:helix_name")}
      <span className={cn("ml-1.5", helixStatusToneClassName(status))}>
        {t(helixChatStatusLabelKey(status))}
      </span>
      {pendingOff ? (
        <span className="ml-1.5 text-muted-foreground" data-testid="helix-capsule-pending-off">
          · {t("chat:helix_capsulePendingOff")}
        </span>
      ) : null}
    </>
  );
}

function HelixOffBuilderCapsule({
  builderThreadId,
  onOpenThread,
}: {
  builderThreadId: ThreadId;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { t } = useTranslation();
  const [stopping, setStopping] = useState(false);
  const stop = () => {
    const api = readNativeApi();
    if (!api || stopping) return;
    setStopping(true);
    void api.orchestration
      .dispatchCommand({
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId: builderThreadId,
        requestedBy: "user",
        createdAt: new Date().toISOString(),
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: t("chat:helix_couldNotStop"),
          description: error instanceof Error ? error.message : undefined,
        });
      })
      .finally(() => setStopping(false));
  };
  return (
    <ComposerCapsule
      icon={<LiveStatusSpinner className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />}
      title={t("chat:helix_offBuilderRunningTitle")}
      testId="helix-off-builder-capsule"
      actions={
        <>
          <button
            type="button"
            className={COMPOSER_CAPSULE_ACTION_CLASS_NAME}
            aria-label={t("chat:helix_openBuilderAria")}
            onClick={() => onOpenThread(builderThreadId)}
          >
            {t("chat:helix_openBuilderShort")}
          </button>
          <button
            type="button"
            className={COMPOSER_CAPSULE_ACTION_CLASS_NAME}
            aria-label={t("chat:helix_stopBuilderAria")}
            disabled={stopping}
            onClick={stop}
          >
            {t("chat:helix_stopBuilder")}
          </button>
        </>
      }
    >
      {t("chat:helix_offBuilderRunning")}
    </ComposerCapsule>
  );
}

function HelixUserInputForm({
  threadId,
  request,
}: {
  threadId: ThreadId;
  request: PendingUserInput;
}) {
  const { t } = useTranslation();
  const questions = request.questions;
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const activeQuestion = questions[Math.min(questionIndex, questions.length - 1)];
  const isLastQuestion = questionIndex >= questions.length - 1;
  const resolved = buildPendingUserInputAnswers(questions, answers);

  const submit = (requestId: ApprovalRequestId) => {
    const api = readNativeApi();
    if (!api || !resolved || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    void api.orchestration
      .dispatchCommand({
        type: "thread.user-input.respond",
        commandId: newCommandId(),
        threadId,
        requestId,
        answers: resolved,
        ...(request.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: request.lifecycleGeneration }
          : {}),
        createdAt: new Date().toISOString(),
      })
      .then(() => {
        clearThreadDetailResumeCursor(threadId);
        return api.orchestration.subscribeThread(buildThreadSubscribeInput(threadId));
      })
      .catch(() => setError(t("chat:helix_answerFailed")))
      .finally(() => {
        inFlight.current = false;
        setSubmitting(false);
      });
  };

  if (!activeQuestion) return null;
  const advance = () => {
    if (!isLastQuestion) {
      setQuestionIndex(questionIndex + 1);
      return;
    }
    submit(request.requestId);
  };
  const customAnswer = answers[activeQuestion.id]?.customAnswer ?? "";
  return (
    <form
      aria-label={t("chat:helix_builderAsks")}
      onSubmit={(event) => {
        event.preventDefault();
        advance();
      }}
    >
      <UserInputQuestionForm
        questions={questions}
        answers={answers}
        questionIndex={questionIndex}
        submissionVersion={0}
        isResponding={submitting}
        autoAdvance={false}
        keyboardShortcuts="local"
        onToggleOption={(questionId, label) => {
          const draft = togglePendingUserInputOptionSelection(
            activeQuestion,
            answers[questionId],
            label,
          );
          setAnswers((current) => ({ ...current, [questionId]: draft }));
          return draft;
        }}
        onAdvance={advance}
        onPrevious={() => setQuestionIndex(Math.max(0, questionIndex - 1))}
      >
        <div className="mt-3 space-y-2">
          <Textarea
            aria-label={t("chat:answer2", { value0: activeQuestion.question })}
            value={customAnswer}
            disabled={submitting}
            rows={2}
            placeholder={
              activeQuestion.options.length > 0
                ? t("chat:orTypeYourOwnAnswer")
                : t("chat:typeYourAnswer")
            }
            onChange={(event) => {
              const draft = setPendingUserInputCustomAnswer(
                answers[activeQuestion.id],
                event.target.value,
              );
              setAnswers((current) => ({ ...current, [activeQuestion.id]: draft }));
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              advance();
            }}
          />
          {error ? (
            <p role="alert" className="text-ui leading-snug text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={submitting || (isLastQuestion && resolved === null)}
            >
              {submitting
                ? t("chat:submitting")
                : isLastQuestion
                  ? t("chat:sendAnswer")
                  : t("onboarding:common_next")}
            </Button>
          </div>
        </div>
      </UserInputQuestionForm>
    </form>
  );
}

function HelixBuilderUserInput({
  builderThreadId,
  onOpenThread,
}: {
  builderThreadId: ThreadId;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { t } = useTranslation();
  useEffect(() => retainThreadDetailSubscription(builderThreadId), [builderThreadId]);
  const thread = useStore(useMemo(() => createThreadSelector(builderThreadId), [builderThreadId]));
  if (!thread || !canSessionAnswerPendingRequests(thread.session)) return null;
  const pending = derivePendingUserInputs(thread.activities, thread.pendingInteractions, {
    authoritativeHasPending: thread.hasPendingUserInput,
    latestTurnId: thread.latestTurn?.turnId,
  });
  const request = pending[0];
  if (!request) return null;
  return (
    <section
      data-testid="helix-builder-question"
      aria-label={t("chat:helix_builderAsks")}
      className="mb-2 space-y-2"
    >
      <Button
        variant="ghost"
        size="sm"
        className="h-auto max-w-full justify-start truncate p-0 text-ui font-medium hover:bg-transparent hover:underline"
        onClick={() => onOpenThread(builderThreadId)}
      >
        {thread.title}
      </Button>
      <HelixUserInputForm
        key={pendingRequestInstanceKey(request.requestId, request.lifecycleGeneration)}
        threadId={builderThreadId}
        request={request}
      />
    </section>
  );
}

function HelixBuilderRequests({
  leadThreadId,
  builderThreadId,
  onOpenThread,
}: {
  leadThreadId: ThreadId;
  builderThreadId: ThreadId;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const [hasApprovals, hasUserInput] = useStore(
    useShallow((state) => {
      const builder = state.sidebarThreadSummaryById[builderThreadId];
      return [builder?.hasPendingApprovals === true, builder?.hasPendingUserInput === true];
    }),
  );
  if (!hasApprovals && !hasUserInput) return null;
  return (
    <div {...{ [HELIX_BUILDER_REQUESTS_ATTRIBUTE]: leadThreadId }}>
      {hasApprovals ? (
        <HubPendingApprovals threadIds={[builderThreadId]} onOpenThread={onOpenThread} />
      ) : null}
      {hasUserInput && !hasApprovals ? (
        <HelixBuilderUserInput builderThreadId={builderThreadId} onOpenThread={onOpenThread} />
      ) : null}
    </div>
  );
}

function HelixBuilderThreadNotice({
  leadThreadId,
  locked,
  onOpenThread,
}: {
  leadThreadId: ThreadId;
  locked: boolean;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { t } = useTranslation();
  const leadTitle = useStore((state) => state.sidebarThreadSummaryById[leadThreadId]?.title ?? "");
  return (
    <div
      role="status"
      data-testid="helix-builder-notice"
      className="mb-2 flex flex-col gap-1.5 rounded-xl border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary-opaque)] px-3 py-2 text-ui"
    >
      <button
        type="button"
        className="inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-[color:var(--color-border)] px-3 py-1 text-ui-sm text-muted-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground"
        onClick={() => onOpenThread(leadThreadId)}
        aria-label={t("chat:helix_openLead", { value0: leadTitle })}
      >
        <BackToParentIcon className="size-3 shrink-0" />
        <span className="shrink-0">{t("chat:helix_builderFor")}</span>
        <span className="min-w-0 truncate font-medium text-foreground/85">{leadTitle}</span>
        <ArrowUpRightIcon className="size-3 shrink-0" />
      </button>
      {locked ? (
        <span className="text-[var(--color-text-foreground-secondary)]">
          {t("chat:helix_builderLocked")}
        </span>
      ) : null}
    </div>
  );
}

/** A pair whose stored data the server cannot read: Helix does nothing for it until removed. */
function HelixQuarantineNotice({ entry }: { entry: HelixQuarantinedPair }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const remove = () => {
    const api = readNativeApi();
    if (!api || busy) return;
    setBusy(true);
    void api.dialogs
      .confirm(t("chat:helix_quarantine_confirm"))
      .then((confirmed) => (confirmed ? removeHelixPair(entry) : null))
      .then((result) => {
        if (result?.ok) toastManager.add({ type: "success", title: t("chat:helix_removed") });
      })
      .finally(() => setBusy(false));
  };
  return (
    <div
      role="status"
      data-testid="helix-quarantine-notice"
      className={cn(
        "mb-2 flex items-start gap-2 rounded-md border border-[color:var(--color-border-light)]",
        "bg-[var(--sidebar-accent)]/40 px-3 py-2 text-ui text-muted-foreground",
      )}
    >
      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{t("chat:helix_quarantine_title")}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={busy || readNativeApi()?.helix?.removePair === undefined}
        className="h-6 shrink-0 px-2 text-ui"
        onClick={remove}
      >
        {t("chat:helix_quarantine_remove")}
      </Button>
    </div>
  );
}

/**
 * A Helix Builder thread: "locked" while its pair is active (its composer takes no new
 * messages), "builder" otherwise, null for any other thread. Read regardless of the
 * setting, because the server applies a Builder's restrictions regardless of it.
 */
export function useHelixBuilderRole(threadId: ThreadId | null): "locked" | null {
  // A Builder takes no typed messages while its pair exists: active, turned off or
  // quarantined (the server refuses them as `builder_read_only`).
  const leadThreadId = useHelixBuilderLeadThreadId(threadId);
  return leadThreadId === null ? null : "locked";
}

/** Not-applied note, quarantine notice, the at-a-glance Helix line, Builder requests and the Builder-transcript notice. */
export function HelixComposerNotices({
  threadId,
  onOpenThread,
}: {
  threadId: ThreadId;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const enabled = useHelixEnabled();
  const summary = activePairSummary(useHelixLeadSummary(enabled ? threadId : null));
  // A Builder's notice explains its locked composer, so it shows even with Helix off.
  const builderLeadThreadId = useHelixBuilderLeadThreadId(threadId);
  const quarantine = useHelixStore((state) =>
    enabled ? (state.quarantinedByLeadThreadId.get(threadId) ?? null) : null,
  );
  return (
    <>
      {/* A message's Helix change that was not applied; shown even with the setting off. */}
      <HelixPairingNoteBanner threadId={threadId} />
      {quarantine ? <HelixQuarantineNotice entry={quarantine} /> : null}
      {summary ? <HelixActivityBanner summary={summary} /> : null}
      {summary ? (
        <HelixBuilderRequests
          leadThreadId={threadId}
          builderThreadId={summary.builderThreadId}
          onOpenThread={onOpenThread}
        />
      ) : null}
      {builderLeadThreadId ? (
        <HelixBuilderThreadNotice
          leadThreadId={builderLeadThreadId}
          locked
          onOpenThread={onOpenThread}
        />
      ) : null}
    </>
  );
}
