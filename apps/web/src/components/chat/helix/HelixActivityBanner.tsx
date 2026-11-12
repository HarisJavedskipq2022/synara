// FILE: HelixActivityBanner.tsx
// Purpose: The at-a-glance Helix line above a Lead's composer. It says what the pair is
//          doing right now: the Builder's current step and how long its command has run
//          (with "may be stuck" and Stop after three minutes), what the Builder waits on
//          with a button to answer it, "finished · Lead is reviewing", or why Helix is
//          held or stopped (with Resume). Also the calm note when a message's Helix
//          change was not applied. The Builder thread's activity is read only while the
//          Builder works or waits, and only while its Lead chat is open.
// Layer: Chat Helix UI
// Exports: HelixActivityBanner, HelixPairingNoteBanner, HELIX_BUILDER_REQUESTS_ATTRIBUTE

import type { HelixHandoffState, HelixPairSummary, ThreadId } from "@synara/contracts";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { useTranslation } from "~/i18n";
import {
  clearPendingHelixTurnOff,
  dismissHelixPairingNote,
  useHelixDraftStore,
} from "~/helix/helixDraftStore";
import { helixPairingNotAppliedMessageKey } from "~/helix/helixErrors";
import {
  HELIX_MAY_BE_STUCK_MS,
  helixElapsedMinutes,
  useHelixMinuteClock,
} from "~/helix/helixMinuteClock";
import {
  canResumeHelixPair,
  canStopHelixPair,
  helixHandoffStateLabelKey,
  helixHoldHandoffState,
  isHelixBuilderRunning,
} from "~/helix/helixPresentation";
import { resumeHelixPair, stopHelixPair } from "~/helix/helixActions";
import { useHelixLeadDetail } from "~/helix/useHelix";
import { HandoffIcon, InfoIcon, TriangleAlertIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { derivePendingApprovals } from "../../../pendingInteractionDerivation";
import { useStore } from "../../../store";
import { createThreadSelector } from "../../../storeSelectors";
import { retainThreadDetailSubscription } from "../../../threadDetailSubscriptionRetention";
import { isThreadActivelyWorking } from "../../Sidebar.logic";
import { Button } from "../../ui/button";
import { LiveStatusSpinner } from "../../ui/spinner";
import { firstLinePreview, latestToolStep, type LatestToolStep } from "../SubagentRunCard.logic";
import { helixHoldCopy } from "./helixHoldCopy";

/** Marks the Builder's approval/question forms so "Answer" can bring them into view. */
export const HELIX_BUILDER_REQUESTS_ATTRIBUTE = "data-helix-builder-requests";

const BANNER_CLASS_NAME = cn(
  "mb-2 flex min-h-8 items-center gap-2 rounded-md border border-[color:var(--color-border-light)]",
  "bg-[var(--sidebar-accent)]/40 px-3 py-1.5 text-ui text-muted-foreground",
);

const BANNER_ACTION_CLASS_NAME = "h-6 shrink-0 px-2 text-ui";

const STOPPED_HANDOFF_STATES = new Set<HelixHandoffState>(["failed", "interrupted", "cancelled"]);

function BannerLine({
  icon,
  children,
  action,
  testId,
  tone,
}: {
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  testId: string;
  tone?: "warning" | undefined;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className={cn(BANNER_CLASS_NAME, tone === "warning" && "text-foreground/85")}
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {action}
    </div>
  );
}

function focusBuilderRequests(leadThreadId: ThreadId) {
  const block = document.querySelector<HTMLElement>(
    `[${HELIX_BUILDER_REQUESTS_ATTRIBUTE}="${CSS.escape(leadThreadId)}"]`,
  );
  if (!block) return;
  block.scrollIntoView({ block: "nearest" });
  block
    .querySelector<HTMLElement>(
      "button:not([disabled]):not([data-thread-link]), textarea, input, [tabindex='0']",
    )
    ?.focus();
}

/** Which line the banner shows, from cheap summary fields only. */
type BannerMode = "held" | "approval" | "question" | "working" | "reviewing" | "stopped" | null;

function useBannerMode(summary: HelixPairSummary): BannerMode {
  const [builderWorking, hasApprovals, hasUserInput] = useStore(
    useShallow((state) => {
      const builder = state.sidebarThreadSummaryById[summary.builderThreadId];
      return [
        builder ? isThreadActivelyWorking(builder) : false,
        builder?.hasPendingApprovals === true,
        builder?.hasPendingUserInput === true,
      ];
    }),
  );
  if (summary.hold) return "held";
  if (hasApprovals) return "approval";
  if (hasUserInput) return "question";
  if (summary.status === "building" && builderWorking) return "working";
  if (summary.status === "reviewing") return "reviewing";
  if (summary.status === "needs_attention") return "stopped";
  return null;
}

/** The Lead chat's one-line Helix status, above its composer. Null for an idle pair. */
export function HelixActivityBanner({ summary }: { summary: HelixPairSummary }) {
  const mode = useBannerMode(summary);
  switch (mode) {
    case "held":
      return <HelixHeldLine summary={summary} />;
    case "approval":
    case "question":
    case "working":
      return <HelixBuilderLiveLine summary={summary} mode={mode} />;
    case "reviewing":
      return <HelixReviewingLine />;
    case "stopped":
      return <HelixStoppedLine summary={summary} />;
    default:
      return null;
  }
}

function HelixHeldLine({ summary }: { summary: HelixPairSummary }) {
  const [busy, setBusy] = useState(false);
  const detail = useHelixLeadDetail(summary.leadThreadId);
  const pendingOff = useHelixDraftStore(
    (state) => state.choiceByThreadId.get(summary.leadThreadId)?.enabled === false,
  );
  const hold = summary.hold;
  if (!hold) return null;
  const copy = helixHoldCopy(hold, {
    holdHandoffState: helixHoldHandoffState(summary, detail.view?.handoffs ?? null),
    builderRunning: isHelixBuilderRunning(summary),
    maxDispatchesPerGoal: detail.view?.pair.config.limits.maxDispatchesPerGoal ?? null,
  });
  return (
    <HelixHeldBannerView
      title={copy.title}
      release={copy.release}
      pendingOff={pendingOff}
      canResume={canResumeHelixPair(summary)}
      busy={busy}
      onResume={() => {
        // Resume means "keep going": it also takes back an unsent "turn off".
        clearPendingHelixTurnOff(summary.leadThreadId);
        setBusy(true);
        void resumeHelixPair(summary).finally(() => setBusy(false));
      }}
    />
  );
}

/** The hold line itself; `pendingOff` adds the composer's unsent "turn off". */
export function HelixHeldBannerView({
  title,
  release,
  pendingOff,
  canResume,
  busy,
  onResume,
}: {
  title: string;
  release: string | null;
  pendingOff: boolean;
  canResume: boolean;
  busy: boolean;
  onResume: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="status"
      data-testid="helix-held-banner"
      className={cn(BANNER_CLASS_NAME, "items-start py-2")}
    >
      <HandoffIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground/85">{title}.</span>
        {release ? <> {release}</> : null}
        {pendingOff ? (
          <>
            {" "}
            <span className="text-muted-foreground" data-testid="helix-held-pending-off">
              {t("chat:helix_pendingOffNote")}
            </span>
          </>
        ) : null}
      </span>
      {canResume ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          className={BANNER_ACTION_CLASS_NAME}
          aria-label={t("chat:helix_resumeAria")}
          onClick={onResume}
        >
          {t("chat:helix_resume")}
        </Button>
      ) : null}
    </div>
  );
}

function stepText(step: LatestToolStep | null): string | null {
  if (!step) return null;
  return step.action.command ?? step.action.label;
}

/** Working or waiting: reads the Builder thread's activity (subscribed only while shown). */
function HelixBuilderLiveLine({
  summary,
  mode,
}: {
  summary: HelixPairSummary;
  mode: "approval" | "question" | "working";
}) {
  const { t } = useTranslation();
  const builderThreadId = summary.builderThreadId;
  useEffect(() => retainThreadDetailSubscription(builderThreadId), [builderThreadId]);
  const thread = useStore(useMemo(() => createThreadSelector(builderThreadId), [builderThreadId]));
  const step = thread ? latestToolStep(thread.activities) : null;
  const runningStep = step?.running ? step : null;
  const nowMs = useHelixMinuteClock(mode === "working" && runningStep !== null);
  const [stopping, setStopping] = useState(false);

  if (mode === "approval" || mode === "question") {
    const approval =
      mode === "approval" && thread
        ? derivePendingApprovals(thread.activities, thread.pendingInteractions, {
            authoritativeHasPending: thread.hasPendingApprovals,
            latestTurnId: thread.latestTurn?.turnId,
          })[0]
        : undefined;
    const what = firstLinePreview(approval?.detail ?? stepText(step));
    return (
      <BannerLine
        testId="helix-banner-waiting"
        icon={<InfoIcon className="size-3.5" aria-hidden />}
        action={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={BANNER_ACTION_CLASS_NAME}
            onClick={() => focusBuilderRequests(summary.leadThreadId)}
          >
            {t("chat:helix_answer")}
          </Button>
        }
      >
        <span className="font-medium text-foreground/85">
          {mode === "approval"
            ? t("chat:helix_bannerWaitingApproval")
            : t("chat:helix_bannerWaitingQuestion")}
        </span>
        {what ? <span className="ml-1.5">{what}</span> : null}
      </BannerLine>
    );
  }

  const text = firstLinePreview(stepText(step));
  const elapsedMs = runningStep ? nowMs - Date.parse(runningStep.startedAt) : 0;
  const minutes = runningStep ? helixElapsedMinutes(runningStep.startedAt, nowMs) : null;
  const mayBeStuck = runningStep !== null && elapsedMs >= HELIX_MAY_BE_STUCK_MS;
  const stop = () => {
    if (stopping) return;
    setStopping(true);
    void stopHelixPair(summary).finally(() => setStopping(false));
  };
  return (
    <BannerLine
      testId="helix-banner-working"
      tone={mayBeStuck ? "warning" : undefined}
      icon={
        mayBeStuck ? (
          <TriangleAlertIcon className="size-3.5" aria-hidden />
        ) : (
          <LiveStatusSpinner className="size-3" />
        )
      }
      action={
        mayBeStuck && canStopHelixPair(summary) ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={BANNER_ACTION_CLASS_NAME}
            disabled={stopping}
            aria-label={t("chat:helix_stopAria")}
            onClick={stop}
          >
            {t("chat:helix_stop")}
          </Button>
        ) : undefined
      }
    >
      <span className="font-medium text-foreground/85">{t("chat:helix_builder")}</span>
      <span className="ml-1.5">{text ?? t("chat:helix_bannerWorking")}</span>
      {minutes !== null ? (
        <span className="ml-1.5 tabular-nums">
          ·{" "}
          {minutes < 1
            ? t("chat:helix_bannerUnderAMinute")
            : t("chat:helix_bannerMinutes", { count: minutes })}
        </span>
      ) : null}
      {mayBeStuck ? <span className="ml-1.5">· {t("chat:helix_bannerMayBeStuck")}</span> : null}
    </BannerLine>
  );
}

function HelixReviewingLine() {
  const { t } = useTranslation();
  return (
    <BannerLine testId="helix-banner-reviewing" icon={<LiveStatusSpinner className="size-3" />}>
      <span className="font-medium text-foreground/85">{t("chat:helix_bannerFinished")}</span>
      <span className="ml-1.5">· {t("chat:helix_bannerLeadReviewing")}</span>
    </BannerLine>
  );
}

/** A handoff that ended without a result and no hold: say so, with its reason. */
function HelixStoppedLine({ summary }: { summary: HelixPairSummary }) {
  const { t } = useTranslation();
  const detail = useHelixLeadDetail(summary.leadThreadId);
  const latest = detail.view?.handoffs[0] ?? null;
  // The summary carries the latest handoff's state and failure; older servers need the view.
  const state = summary.latestHandoffState ?? latest?.state ?? null;
  if (state === null || !STOPPED_HANDOFF_STATES.has(state)) return null;
  const reason = firstLinePreview(summary.latestHandoffFailure ?? latest?.failure?.reason ?? null);
  return (
    <BannerLine
      testId="helix-banner-stopped"
      icon={<TriangleAlertIcon className="size-3.5" aria-hidden />}
    >
      <span className="font-medium text-foreground/85">{t("chat:helix_bannerStopped")}</span>
      <span className="ml-1.5">· {t(helixHandoffStateLabelKey(state))}</span>
      {reason ? <span className="ml-1.5">· {reason}</span> : null}
    </BannerLine>
  );
}

/** A sent message's Helix change was not applied. The message itself went out. */
export function HelixPairingNoteBanner({ threadId }: { threadId: ThreadId }) {
  const { t } = useTranslation();
  const note = useHelixDraftStore((state) => state.noteByThreadId.get(threadId) ?? null);
  if (!note) return null;
  const reasonKey = note.reason ? helixPairingNotAppliedMessageKey(note.reason) : null;
  const reason = reasonKey ? t(reasonKey) : (note.message ?? t("chat:helix_error_unknown"));
  return (
    <div
      role="status"
      data-testid="helix-pairing-note"
      className={cn(BANNER_CLASS_NAME, "items-start py-2")}
    >
      <InfoIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground/85">
          {note.enabled ? t("chat:helix_notAppliedOn") : t("chat:helix_notAppliedOff")}
        </span>{" "}
        {reason}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="-my-0.5 shrink-0"
        aria-label={t("chat:helix_dismissNote")}
        onClick={() => dismissHelixPairingNote(threadId)}
      >
        <XIcon className="size-3" />
      </Button>
    </div>
  );
}
