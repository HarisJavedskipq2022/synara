// FILE: helixPresentation.ts
// Purpose: Pure display rules for Helix: the one pair status a chat and its sidebar row
//          show, what a hold means and what releases it, and the labels for handoff
//          states, results and the Lead's verdict. "Accepted" is always worded as the
//          Lead's own verdict, never as a review by the user.
// Layer: Web Helix presentation logic (no React)
// Exports: status, hold, handoff and verdict helpers

import {
  isHelixHandoffActive,
  type HelixBuilderResult,
  type HelixHandoff,
  type HelixHandoffState,
  type HelixHold,
  type HelixLateResultReason,
  type HelixPairSummary,
  type HelixReviewVerdict,
} from "@synara/contracts";

/**
 * The pair status shown in the chat and on the Lead's sidebar row. The contract's
 * `idle` becomes `planning` while the Lead itself is working, and a hold or handoff
 * whose Builder send may or may not have arrived is called out as `uncertain`.
 */
export type HelixChatStatus =
  | "planning"
  | "building"
  | "reviewing"
  | "needs_attention"
  | "uncertain"
  | "paused"
  | "stopped"
  | "idle";

export function resolveHelixChatStatus(input: {
  readonly summary: Pick<HelixPairSummary, "lifecycle" | "status" | "hold">;
  readonly leadWorking: boolean;
  readonly latestState?: HelixHandoffState | null | undefined;
}): HelixChatStatus | null {
  const { summary } = input;
  if (summary.lifecycle === "disabled" || summary.status === "disabled") return null;
  switch (summary.status) {
    case "stopped":
      return "stopped";
    case "paused":
      return "paused";
    case "needs_attention":
      return isUncertainSend(summary.hold, input.latestState ?? null) ||
        (summary.hold === null && input.latestState === "uncertain")
        ? "uncertain"
        : "needs_attention";
    case "building":
      return "building";
    case "reviewing":
      return "reviewing";
    default:
      return input.leadWorking ? "planning" : "idle";
  }
}

const STATUS_LABEL_KEYS: Readonly<Record<HelixChatStatus, string>> = {
  planning: "chat:helix_status_planning",
  building: "chat:helix_status_building",
  reviewing: "chat:helix_status_reviewing",
  needs_attention: "chat:helix_status_needsAttention",
  uncertain: "chat:helix_status_uncertain",
  paused: "chat:helix_status_paused",
  stopped: "chat:helix_status_stopped",
  idle: "chat:helix_status_idle",
};

export function helixChatStatusLabelKey(status: HelixChatStatus): string {
  return STATUS_LABEL_KEYS[status];
}

/** Statuses in the "working" family (tone). */
export function isHelixChatStatusLive(status: HelixChatStatus): boolean {
  return status === "planning" || status === "building" || status === "reviewing";
}

/** Whether an agent is running right now (spinner rather than a dot). A result can wait
 *  for the Lead's review while the Lead is idle. */
export function isHelixChatStatusRunning(status: HelixChatStatus, leadWorking: boolean): boolean {
  return status === "reviewing" ? leadWorking : status === "planning" || status === "building";
}

/** Statuses that ask something of the user. */
export function isHelixChatStatusAttention(status: HelixChatStatus): boolean {
  return status === "needs_attention" || status === "uncertain";
}

/** What a Lead's sidebar row needs: the pair status and whether its Builder waits on you. */
export interface HelixRowStatus {
  /** `idle` when the pair has nothing to show; the row adds "Planning" while the Lead works. */
  readonly status: HelixChatStatus;
  readonly builderHasPendingApprovals: boolean;
  readonly builderHasPendingUserInput: boolean;
}

// ── Holds ──────────────────────────────────────────────────────────────

/**
 * An `uncertain` hold covers two cases: a Builder send that may or may not have arrived
 * (its handoff is `uncertain`), and a result Helix could not deliver to the Lead after
 * repeated wakes (its handoff is not). Without the handoff's state, assume the send.
 */
export function isHelixWakeFailureHold(
  hold: Pick<HelixHold, "kind"> | null,
  holdHandoffState: HelixHandoffState | null,
): boolean {
  return (
    hold?.kind === "uncertain" && holdHandoffState !== null && holdHandoffState !== "uncertain"
  );
}

/** The state of the handoff a hold names: from the full view when loaded, else the latest. */
export function helixHoldHandoffState(
  summary: Pick<HelixPairSummary, "hold" | "latestHandoffState">,
  handoffs: readonly Pick<HelixHandoff, "id" | "state">[] | null,
): HelixHandoffState | null {
  const handoffId = summary.hold?.handoffId ?? null;
  const named =
    handoffId !== null ? handoffs?.find((handoff) => handoff.id === handoffId) : undefined;
  return named?.state ?? summary.latestHandoffState ?? null;
}

function isUncertainSend(
  hold: Pick<HelixHold, "kind"> | null,
  holdHandoffState: HelixHandoffState | null,
): boolean {
  return hold?.kind === "uncertain" && !isHelixWakeFailureHold(hold, holdHandoffState);
}

/**
 * The chat's own sentence for a hold the web knows. Null for a kind added after this
 * build: the caller then shows the server's `reason` text instead.
 */
export function helixHoldTitleKey(hold: Pick<HelixHold, "kind" | "limit">): string | null {
  switch (hold.kind) {
    case "stop":
      return "chat:helix_hold_stop";
    case "pause":
      return "chat:helix_hold_pause";
    case "limit":
      return hold.limit === "work_item_corrections"
        ? "chat:helix_hold_limitCorrections"
        : "chat:helix_hold_limitDispatches";
    case "restart":
      return "chat:helix_hold_restart";
    case "uncertain":
      return "chat:helix_hold_uncertain";
    default:
      return null;
  }
}

/**
 * What releases a hold (docs/plans/helix-prototype.md, "Hold release"). After a restart
 * a running handoff keeps running; its result waits for Resume.
 */
export function helixHoldReleaseKey(
  hold: Pick<HelixHold, "kind" | "limit">,
  builderRunning = false,
): string | null {
  switch (hold.kind) {
    case "stop":
      return "chat:helix_release_stop";
    case "pause":
      return "chat:helix_release_pause";
    case "limit":
      return hold.limit === "work_item_corrections"
        ? "chat:helix_release_limitCorrections"
        : "chat:helix_release_limitDispatches";
    case "restart":
      return builderRunning ? "chat:helix_release_restartRunning" : "chat:helix_release_restart";
    case "uncertain":
      return "chat:helix_release_uncertain";
    default:
      return null;
  }
}

/** A handoff in the Builder slot, from the summary alone. */
export function isHelixBuilderRunning(
  summary: Pick<HelixPairSummary, "activeHandoffId" | "latestHandoffState">,
): boolean {
  return (
    summary.activeHandoffId !== null ||
    (summary.latestHandoffState != null && isHelixHandoffActive(summary.latestHandoffState))
  );
}

const LATE_RESULT_LABEL_KEYS: Readonly<Record<HelixLateResultReason, string>> = {
  stop: "chat:helix_lateResult_stop",
  uncertain_send: "chat:helix_lateResult_uncertainSend",
  interrupted: "chat:helix_lateResult_interrupted",
};

const LATE_RESULT_NOTE_KEYS: Readonly<Record<HelixLateResultReason, string>> = {
  stop: "chat:helix_lateResultNote_stop",
  uncertain_send: "chat:helix_lateResultNote_uncertainSend",
  interrupted: "chat:helix_lateResultNote_interrupted",
};

/** "Arrived after Stop" only when Stop was the reason; older rows carry no reason. */
export function helixLateResultLabelKey(reason: HelixLateResultReason | undefined): string {
  return reason ? LATE_RESULT_LABEL_KEYS[reason] : "chat:helix_lateResult";
}

export function helixLateResultNoteKey(reason: HelixLateResultReason | undefined): string {
  return reason ? LATE_RESULT_NOTE_KEYS[reason] : "chat:helix_lateResultNote";
}

// ── Controls ───────────────────────────────────────────────────────────

type ControlSummary = Pick<HelixPairSummary, "lifecycle" | "status" | "hold" | "activeHandoffId">;

/**
 * Enable/disable and configuration changes are offered only while nothing is in the
 * Builder slot and no result awaits the Lead's review (the server refuses otherwise).
 */
export function isHelixPairIdle(summary: ControlSummary): boolean {
  return (
    summary.lifecycle === "active" &&
    summary.activeHandoffId === null &&
    summary.status !== "building" &&
    summary.status !== "reviewing"
  );
}

export function canPauseHelixPair(summary: ControlSummary): boolean {
  return summary.lifecycle === "active" && summary.hold === null;
}

export function canResumeHelixPair(summary: ControlSummary): boolean {
  return summary.lifecycle === "active" && summary.hold !== null;
}

/** Stop always wins, so it is offered whenever the pair is active and not already stopped. */
export function canStopHelixPair(summary: ControlSummary): boolean {
  return summary.lifecycle === "active" && summary.hold?.kind !== "stop";
}

// ── Handoffs ───────────────────────────────────────────────────────────

const HANDOFF_STATE_LABEL_KEYS: Readonly<Record<HelixHandoffState, string>> = {
  prepared: "chat:helix_handoff_prepared",
  dispatching: "chat:helix_handoff_dispatching",
  running: "chat:helix_handoff_running",
  awaiting_review: "chat:helix_handoff_awaitingReview",
  accepted: "chat:helix_verdict_accepted",
  changes_requested: "chat:helix_verdict_changesRequested",
  blocked: "chat:helix_verdict_blocked",
  failed: "chat:helix_handoff_failed",
  interrupted: "chat:helix_handoff_interrupted",
  cancelled: "chat:helix_handoff_cancelled",
  uncertain: "chat:helix_handoff_uncertain",
};

export function helixHandoffStateLabelKey(state: HelixHandoffState): string {
  return HANDOFF_STATE_LABEL_KEYS[state];
}

export type HelixTone = "live" | "success" | "warning" | "danger" | "muted";

export function helixHandoffStateTone(state: HelixHandoffState): HelixTone {
  if (isHelixHandoffActive(state) || state === "awaiting_review") return "live";
  if (state === "accepted") return "success";
  if (state === "changes_requested" || state === "blocked" || state === "uncertain") {
    return "warning";
  }
  if (state === "failed") return "danger";
  return "muted";
}

const VERDICT_LABEL_KEYS: Readonly<Record<HelixReviewVerdict, string>> = {
  accepted: "chat:helix_verdict_accepted",
  changes_requested: "chat:helix_verdict_changesRequested",
  blocked: "chat:helix_verdict_blocked",
};

/** Always "Lead accepted", "Lead requested changes", "Lead blocked": the Lead's verdict. */
export function helixVerdictLabelKey(verdict: HelixReviewVerdict): string {
  return VERDICT_LABEL_KEYS[verdict];
}

const OUTCOME_LABEL_KEYS: Readonly<Record<HelixBuilderResult["outcome"], string>> = {
  completed: "chat:helix_outcome_completed",
  partial: "chat:helix_outcome_partial",
  blocked: "chat:helix_outcome_blocked",
  failed: "chat:helix_outcome_failed",
  interrupted: "chat:helix_outcome_interrupted",
};

export function helixOutcomeLabelKey(outcome: HelixBuilderResult["outcome"]): string {
  return OUTCOME_LABEL_KEYS[outcome];
}

export function helixOutcomeTone(outcome: HelixBuilderResult["outcome"]): HelixTone {
  if (outcome === "completed") return "success";
  if (outcome === "failed") return "danger";
  if (outcome === "interrupted") return "muted";
  return "warning";
}

/** Newest first, by sequence; the view already sends them that way, events may not. */
export function sortHelixHandoffs(handoffs: readonly HelixHandoff[]): HelixHandoff[] {
  return handoffs.toSorted((left, right) => right.sequence - left.sequence);
}

/** Merge one handoff into a list, keeping the higher revision of the same id. */
export function upsertHelixHandoff(
  handoffs: readonly HelixHandoff[],
  next: HelixHandoff,
): readonly HelixHandoff[] {
  const index = handoffs.findIndex((handoff) => handoff.id === next.id);
  if (index === -1) return sortHelixHandoffs([...handoffs, next]);
  const current = handoffs[index]!;
  if (current.revision > next.revision) return handoffs;
  const copy = [...handoffs];
  copy[index] = next;
  return copy;
}

/** "Corrections 1 of 3" belongs to the work item; the brief carries the correction itself. */
export function isHelixCorrection(handoff: Pick<HelixHandoff, "correctionIndex">): boolean {
  return handoff.correctionIndex > 0;
}
