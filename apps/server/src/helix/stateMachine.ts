/**
 * The Helix pair and handoff state machine. Pure: no I/O, no clock, no ids.
 *
 * Every function takes the current aggregate (a pair plus the handoffs a
 * command can touch) and a command carrying its own `now` and pre-generated
 * ids, and returns either a refusal or the next rows plus the effects the
 * coordinator must perform AFTER committing those rows with
 * `HelixRepository.commit({ pair, expectedRevision, handoffs: writes })`.
 *
 * Invariants it maintains (docs/plans/helix-prototype.md, "State machines"):
 * - at most one handoff is prepared, dispatching or running;
 * - automatic work (dispatch, Lead wake) is only ever emitted when the pair is
 *   active, has no hold, and the handoff belongs to the current cancellation
 *   epoch;
 * - Stop bumps the epoch, sets a hold, closes active handoffs and suppresses
 *   every pending delivery; results that arrive afterwards are recorded as
 *   `lateResult` and never delivered;
 * - every successful change advances the pair revision by exactly one and each
 *   changed handoff's revision by exactly one.
 *
 * Aggregate contract: `handoffs` must contain every non-terminal handoff of
 * the pair, every handoff with a pending or requested delivery, the pair's
 * highest-sequence handoff, the handoff a command names, and (for delegate)
 * the handoff already holding the command's request id, if any.
 *
 * @module helix/stateMachine
 */
import {
  DEFAULT_HELIX_LIMITS,
  helixRoleSupport,
  isHelixHandoffActive,
  type HelixBrief,
  type HelixBriefInput,
  type HelixBuilderReport,
  type HelixBuilderResult,
  type HelixDeliveryState,
  type HelixHandoff,
  type HelixHandoffId,
  type HelixHold,
  type HelixLimits,
  type HelixPair,
  type HelixPairConfig,
  type HelixPendingChange,
  type HelixPairId,
  type HelixReviewVerdict,
  type HelixTurnOutcome,
  type MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderKind,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
} from "@synara/contracts";

import type { HelixHandoffWrite } from "../persistence/Services/HelixRepository.ts";
import {
  helixCorrectionRequestId,
  helixDispatchCommandId,
  helixWakeCommandId,
} from "./identity.ts";

// ── Public types ────────────────────────────────────────────────────────

export interface HelixAggregate {
  readonly pair: HelixPair;
  readonly handoffs: ReadonlyArray<HelixHandoff>;
}

/** What a restart found for one handoff that was dispatching or running. */
export type HelixRestartEvidence =
  /** No engine receipt for the dispatch command: the brief never left the server. */
  | "not_sent"
  /** The engine accepted the command; the provider send may or may not have happened. */
  | "send_uncertain"
  /** A Builder turn exists for the brief; it settles (or the startup turn reconciliation ends it). */
  | "turn_started";

export type HelixCommand =
  | {
      readonly type: "delegate";
      readonly handoffId: HelixHandoffId;
      readonly requestId: string;
      readonly fingerprint: string;
      readonly brief: HelixBriefInput;
      readonly leadTurnId?: TurnId | null;
      readonly now: string;
    }
  | { readonly type: "builder.created"; readonly now: string }
  | {
      readonly type: "dispatch.start";
      readonly handoffId: HelixHandoffId;
      readonly messageId: MessageId;
      /** Frozen into the intent so a resend replays exactly the same command. */
      readonly runtimeMode?: RuntimeMode;
      readonly now: string;
    }
  | {
      readonly type: "dispatch.acknowledged";
      readonly handoffId: HelixHandoffId;
      readonly commandId: string;
      readonly builderTurnId: TurnId | null;
      readonly now: string;
    }
  | {
      readonly type: "dispatch.failed" | "dispatch.uncertain";
      readonly handoffId: HelixHandoffId;
      readonly commandId: string;
      readonly reason: string;
      readonly now: string;
    }
  | {
      /** The brief could not be handed to the engine at all (e.g. the Builder thread was refused). */
      readonly type: "dispatch.abandoned";
      readonly handoffId: HelixHandoffId;
      readonly reason: string;
      readonly now: string;
    }
  | {
      /** The provider command reactor dropped the turn under a hold, before any provider send. */
      readonly type: "dispatch.suppressed";
      readonly handoffId: HelixHandoffId;
      readonly commandId: string;
      readonly now: string;
    }
  | {
      readonly type: "report.submit";
      readonly builderTurnId: TurnId | null;
      readonly report: HelixBuilderReport;
      readonly now: string;
    }
  | {
      /** Only after the Builder turn settled AND its output is fully ingested. */
      readonly type: "turn.settled";
      readonly handoffId: HelixHandoffId;
      readonly builderTurnId: TurnId | null;
      readonly turnOutcome: HelixTurnOutcome;
      readonly finalMessage: string | null;
      readonly now: string;
    }
  | { readonly type: "result.returned"; readonly handoffId: HelixHandoffId; readonly now: string }
  | {
      readonly type: "wake.request";
      readonly handoffId: HelixHandoffId;
      readonly messageId: MessageId;
      readonly runtimeMode?: RuntimeMode;
      readonly interactionMode?: ProviderInteractionMode;
      /** Requested by an explicit Resume: allowed once past the automatic cap. */
      readonly afterResume?: boolean;
      readonly now: string;
    }
  | {
      readonly type: "wake.dispatched" | "wake.suppressed";
      readonly handoffId: HelixHandoffId;
      readonly commandId: string;
      readonly now: string;
    }
  | {
      readonly type: "review";
      readonly handoffId: HelixHandoffId;
      readonly requestId: string;
      readonly verdict: HelixReviewVerdict;
      readonly feedback: string;
      readonly expectedResultRevision?: number;
      /** Pre-generated id for the correction handoff a changes_requested verdict creates. */
      readonly nextHandoffId: HelixHandoffId;
      /** `helixRequestFingerprint({ kind: "correction", brief })` of that handoff's brief. */
      readonly nextFingerprint: string;
      readonly leadTurnId?: TurnId | null;
      readonly now: string;
    }
  | { readonly type: "stop"; readonly now: string }
  | {
      readonly type: "pause" | "resume" | "disable" | "enable";
      readonly expectedRevision: number;
      /** enable only: re-cap the Builder's mode to the Lead's current mode. */
      readonly builderRuntimeMode?: RuntimeMode;
      readonly now: string;
    }
  /**
   * The user deleted a disabled pair's Builder thread: the pair keeps its
   * history and gets a fresh Builder id, created lazily at the next dispatch.
   */
  | { readonly type: "builder.replaced"; readonly builderThreadId: ThreadId; readonly now: string }
  | {
      readonly type: "config.update";
      readonly expectedRevision: number;
      readonly builderModelSelection?: ModelSelection;
      readonly limits?: HelixLimits;
      /** Pin the role text version actually delivered (idle pairs only). */
      readonly rolePromptVersions?: HelixPairConfig["rolePromptVersions"];
      readonly now: string;
    }
  | { readonly type: "user_message"; readonly messageId: MessageId; readonly now: string }
  /**
   * A message asked for a change the busy pair cannot take now; it is applied
   * at the next idle boundary. Null clears it.
   */
  | {
      readonly type: "config.pending";
      readonly change: HelixPendingChange | null;
      readonly now: string;
    }
  | {
      readonly type: "restart.reconcile";
      readonly evidence: ReadonlyMap<HelixHandoffId, HelixRestartEvidence>;
      readonly now: string;
    };

export type HelixEffect =
  /** A prepared handoff may be dispatched now (create the Builder thread first when asked). */
  | {
      readonly type: "dispatch_ready";
      readonly handoffId: HelixHandoffId;
      readonly needsBuilderThread: boolean;
    }
  /**
   * A result is ready for the Lead. Return it to a blocked Lead tool call if
   * one is waiting (`result.returned`); otherwise, only when `wakeAllowed`,
   * wake the Lead with a new server turn (`wake.request`).
   */
  | {
      readonly type: "deliver_result";
      readonly handoffId: HelixHandoffId;
      readonly wakeAllowed: boolean;
      /** An explicit Resume: one more wake even past the automatic cap. */
      readonly afterResume?: boolean;
    }
  | {
      readonly type: "interrupt_participants";
      readonly leadThreadId: ThreadId;
      readonly builderThreadId: ThreadId;
      /** A handoff was dispatching or running: interrupt the Builder even with no visible turn. */
      readonly builderHadWork: boolean;
    }
  /** Fail every blocked helix_delegate/helix_wait/helix_review of the pair. */
  | { readonly type: "cancel_waits"; readonly epoch: number }
  /** Re-apply gateway role profiles for both participants. */
  | { readonly type: "update_role_profiles" }
  | { readonly type: "archive_builder_thread" }
  | { readonly type: "unarchive_builder_thread" }
  /** The Builder's configuration changed: its next session start must use it. */
  | { readonly type: "restart_builder_session" };

export type HelixTransitionErrorCode =
  | "pair_disabled"
  | "pair_held"
  | "not_held"
  | "handoff_active"
  | "review_pending"
  | "request_conflict"
  | "handoff_not_found"
  | "invalid_transition"
  | "stale_revision"
  | "stale_epoch"
  | "stale_result"
  | "builder_missing"
  | "limit_reached"
  | "feedback_required"
  | "no_running_handoff"
  | "turn_mismatch"
  | "command_mismatch"
  | "unsupported_provider";

export interface HelixTransitionError {
  readonly code: HelixTransitionErrorCode;
  readonly message: string;
  readonly handoffId?: HelixHandoffId;
  readonly hold?: HelixHold;
}

export interface HelixTransitionOk {
  readonly ok: true;
  /** False when the command was an exact replay or a no-op; nothing needs committing. */
  readonly changed: boolean;
  /** True when a request id matched an existing request with identical content. */
  readonly replayed: boolean;
  readonly pair: HelixPair;
  /** The revision the commit must guard on (the input pair's revision). */
  readonly expectedRevision: number;
  readonly writes: ReadonlyArray<HelixHandoffWrite>;
  readonly effects: ReadonlyArray<HelixEffect>;
  /** The handoff the command created or primarily acted on, after the change. */
  readonly handoff: HelixHandoff | null;
}

export type HelixTransition =
  | HelixTransitionOk
  | { readonly ok: false; readonly error: HelixTransitionError };

// ── Pair creation ───────────────────────────────────────────────────────

export interface CreateHelixPairInput {
  readonly pairId: HelixPairId;
  readonly projectId: ProjectId;
  readonly leadThreadId: ThreadId;
  readonly leadProvider: ProviderKind;
  readonly builderThreadId: ThreadId;
  readonly builderModelSelection: ModelSelection;
  readonly builderRuntimeMode: RuntimeMode;
  readonly limits?: HelixLimits;
  readonly now: string;
}

export function createHelixPair(
  input: CreateHelixPairInput,
):
  | { readonly ok: true; readonly pair: HelixPair }
  | { readonly ok: false; readonly error: HelixTransitionError } {
  if (input.leadThreadId === input.builderThreadId) {
    return refuse("invalid_transition", "The Lead and the Builder must be different threads.");
  }
  const lead = helixRoleSupport(input.leadProvider, "lead");
  if (!lead.supported) return refuse("unsupported_provider", lead.reason);
  const builder = helixRoleSupport(input.builderModelSelection.provider, "builder");
  if (!builder.supported) return refuse("unsupported_provider", builder.reason);
  const limits = input.limits ?? DEFAULT_HELIX_LIMITS;
  const config: HelixPairConfig = {
    builderModelSelection: input.builderModelSelection,
    builderRuntimeMode: input.builderRuntimeMode,
    limits,
    rolePromptVersions: { lead: null, builder: null },
  };
  return {
    ok: true,
    pair: {
      id: input.pairId,
      projectId: input.projectId,
      leadThreadId: input.leadThreadId,
      builderThreadId: input.builderThreadId,
      builderCreatedAt: null,
      lifecycle: "active",
      revision: 0,
      cancellationEpoch: 0,
      hold: null,
      goal: {
        seq: 0,
        sourceMessageId: null,
        startedAt: null,
        dispatchCount: 0,
        dispatchBudget: limits.maxDispatchesPerGoal,
      },
      config,
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

// ── Transition ──────────────────────────────────────────────────────────

export function transitionHelix(aggregate: HelixAggregate, command: HelixCommand): HelixTransition {
  const draft = new Draft(aggregate, command.now);
  switch (command.type) {
    case "delegate":
      return delegate(draft, command);
    case "builder.replaced":
      if (draft.pair.lifecycle === "active") {
        return refuse("invalid_transition", "Turn Helix off before removing its Builder.");
      }
      if (draft.pair.builderThreadId === command.builderThreadId) return draft.unchanged(null);
      draft.patchPair({ builderThreadId: command.builderThreadId, builderCreatedAt: null });
      draft.effect({ type: "update_role_profiles" });
      return draft.done(null);
    case "builder.created":
      if (draft.pair.builderCreatedAt !== null) return draft.unchanged(null);
      draft.patchPair({ builderCreatedAt: command.now });
      return draft.done(null);
    case "dispatch.start":
      return dispatchStart(draft, command);
    case "dispatch.acknowledged":
      return dispatchAcknowledged(draft, command);
    case "dispatch.failed":
    case "dispatch.uncertain":
      return dispatchClosed(draft, command);
    case "dispatch.suppressed":
      return dispatchSuppressed(draft, command);
    case "dispatch.abandoned":
      return dispatchAbandoned(draft, command);
    case "report.submit":
      return reportSubmit(draft, command);
    case "turn.settled":
      return turnSettled(draft, command);
    case "result.returned":
      return resultReturned(draft, command);
    case "wake.request":
      return wakeRequest(draft, command);
    case "wake.dispatched":
    case "wake.suppressed":
      return wakeClosed(draft, command);
    case "review":
      return review(draft, command);
    case "stop":
      return stop(draft);
    case "pause":
      return pause(draft, command);
    case "resume":
      return resume(draft, command);
    case "disable":
      return disable(draft, command);
    case "enable":
      return enable(draft, command);
    case "config.update":
      return configUpdate(draft, command);
    case "config.pending": {
      if (draft.pair.lifecycle !== "active" && command.change !== null) {
        return refuse("pair_disabled", "Helix is off for this chat.");
      }
      const current = draft.pair.config.pendingChange ?? null;
      if (JSON.stringify(current) === JSON.stringify(command.change)) return draft.unchanged(null);
      draft.patchPair({ config: { ...draft.pair.config, pendingChange: command.change } });
      return draft.done(null);
    }
    case "user_message":
      return userMessage(draft, command);
    case "restart.reconcile":
      return restartReconcile(draft, command);
  }
}

// ── Command handlers ────────────────────────────────────────────────────

type CommandOf<T extends HelixCommand["type"]> = Extract<HelixCommand, { type: T }>;
interface RevisionedControl {
  readonly expectedRevision: number;
  readonly builderRuntimeMode?: RuntimeMode;
  readonly now: string;
}

function delegate(draft: Draft, command: CommandOf<"delegate">): HelixTransition {
  const existing = draft.handoffs.find((handoff) => handoff.requestId === command.requestId);
  if (existing) {
    return existing.requestFingerprint === command.fingerprint
      ? draft.unchanged(existing, { replayed: true })
      : refuse(
          "request_conflict",
          "This requestId already names a handoff with different content. Use a new requestId for new work.",
          { handoffId: existing.id },
        );
  }
  const blocked = draft.refuseUnlessActiveAndFree();
  if (blocked) return blocked;
  const awaiting = draft.handoffs.find((handoff) => handoff.state === "awaiting_review");
  if (awaiting) {
    return refuse(
      "review_pending",
      "Review the Builder's last result with helix_review before delegating new work. Put further changes in that review's feedback.",
      { handoffId: awaiting.id },
    );
  }
  const handoff = draft.insertHandoff({
    id: command.handoffId,
    requestId: command.requestId,
    requestFingerprint: command.fingerprint,
    workItemId: command.handoffId,
    previousHandoffId: null,
    correctionIndex: 0,
    brief: command.brief,
    leadTurnId: command.leadTurnId ?? null,
  });
  draft.admitDispatch(handoff);
  return draft.done(draft.handoff(handoff.id));
}

function dispatchStart(draft: Draft, command: CommandOf<"dispatch.start">): HelixTransition {
  const handoff = draft.handoff(command.handoffId);
  if (!handoff) return notFound(command.handoffId);
  if (handoff.state !== "prepared") {
    return refuse(
      "invalid_transition",
      `Only a prepared handoff can be dispatched (it is ${handoff.state}).`,
      {
        handoffId: handoff.id,
      },
    );
  }
  const pair = draft.pair;
  if (pair.lifecycle !== "active") return refuse("pair_disabled", "Helix is off for this chat.");
  if (pair.hold !== null) return heldError(pair.hold);
  if (handoff.epoch !== pair.cancellationEpoch) {
    return refuse(
      "stale_epoch",
      "This handoff belongs to a stopped run and will not be dispatched.",
      {
        handoffId: handoff.id,
      },
    );
  }
  if (pair.builderCreatedAt === null) {
    return refuse("builder_missing", "Create the Builder thread before dispatching.", {
      handoffId: handoff.id,
    });
  }
  if (pair.goal.dispatchCount >= pair.goal.dispatchBudget) {
    return refuse("limit_reached", "This goal has used its Builder dispatch budget.", {
      handoffId: handoff.id,
    });
  }
  const attempt = handoff.dispatchAttempts + 1;
  draft.patchHandoff(handoff.id, {
    state: "dispatching",
    dispatchAttempts: attempt,
    dispatch: {
      commandId: helixDispatchCommandId(handoff.id, attempt),
      messageId: command.messageId,
      createdAt: command.now,
      attempt,
      ...(command.runtimeMode === undefined ? {} : { runtimeMode: command.runtimeMode }),
    },
  });
  draft.patchPair({ goal: { ...pair.goal, dispatchCount: pair.goal.dispatchCount + 1 } });
  return draft.done(draft.handoff(handoff.id));
}

function dispatchAcknowledged(
  draft: Draft,
  command: CommandOf<"dispatch.acknowledged">,
): HelixTransition {
  const handoff = draft.handoff(command.handoffId);
  if (!handoff) return notFound(command.handoffId);
  if (handoff.dispatch?.commandId !== command.commandId) {
    return refuse("command_mismatch", "This acknowledgement is for another dispatch attempt.", {
      handoffId: handoff.id,
    });
  }
  if (handoff.state === "running") {
    if (handoff.builderTurnId !== null || command.builderTurnId === null) {
      return draft.unchanged(handoff);
    }
    draft.patchHandoff(handoff.id, { builderTurnId: command.builderTurnId });
    return draft.done(draft.handoff(handoff.id));
  }
  // Stop or a restart already closed it: a late acknowledgement changes nothing.
  if (handoff.state !== "dispatching") return draft.unchanged(handoff);
  draft.patchHandoff(handoff.id, {
    state: "running",
    builderTurnId: command.builderTurnId ?? handoff.builderTurnId,
  });
  return draft.done(draft.handoff(handoff.id));
}

function dispatchClosed(
  draft: Draft,
  command: CommandOf<"dispatch.failed" | "dispatch.uncertain">,
): HelixTransition {
  const handoff = draft.handoff(command.handoffId);
  if (!handoff) return notFound(command.handoffId);
  if (handoff.dispatch?.commandId !== command.commandId) {
    return refuse("command_mismatch", "This outcome is for another dispatch attempt.", {
      handoffId: handoff.id,
    });
  }
  if (handoff.state !== "dispatching" && handoff.state !== "running")
    return draft.unchanged(handoff);
  const failure = { reason: command.reason.slice(0, 2_000), at: command.now };
  if (command.type === "dispatch.failed") {
    draft.patchHandoff(handoff.id, {
      state: "failed",
      failure,
      delivery: draft.deliveryFor(handoff),
    });
    draft.emitDelivery(draft.handoff(handoff.id)!);
    return draft.done(draft.handoff(handoff.id));
  }
  // Possibly consumed input is surfaced, never sent again.
  draft.patchHandoff(handoff.id, { state: "uncertain", failure, delivery: "suppressed" });
  if (draft.pair.hold?.kind !== "stop") {
    draft.setHold({
      kind: "uncertain",
      reason:
        "The brief may or may not have reached the Builder. Helix will not resend it. Check the Builder thread, then resume.",
      limit: null,
      handoffId: handoff.id,
    });
  }
  return draft.done(draft.handoff(handoff.id));
}

function dispatchAbandoned(
  draft: Draft,
  command: CommandOf<"dispatch.abandoned">,
): HelixTransition {
  const handoff = draft.handoff(command.handoffId);
  if (!handoff) return notFound(command.handoffId);
  if (handoff.state !== "prepared" && handoff.state !== "dispatching") {
    return draft.unchanged(handoff);
  }
  draft.patchHandoff(handoff.id, {
    state: "failed",
    dispatch: null,
    failure: { reason: command.reason.slice(0, 2_000), at: command.now },
    delivery: draft.deliveryFor(handoff),
  });
  draft.emitDelivery(draft.handoff(handoff.id)!);
  return draft.done(draft.handoff(handoff.id));
}

function dispatchSuppressed(
  draft: Draft,
  command: CommandOf<"dispatch.suppressed">,
): HelixTransition {
  const handoff = draft.handoff(command.handoffId);
  if (!handoff) return notFound(command.handoffId);
  if (handoff.dispatch?.commandId !== command.commandId || handoff.state !== "dispatching") {
    return draft.unchanged(handoff);
  }
  // The reactor dropped the turn before any provider send: it is provably unsent.
  draft.patchHandoff(handoff.id, { state: "prepared", dispatch: null });
  const goal = draft.pair.goal;
  draft.patchPair({ goal: { ...goal, dispatchCount: Math.max(0, goal.dispatchCount - 1) } });
  return draft.done(draft.handoff(handoff.id));
}

function reportSubmit(draft: Draft, command: CommandOf<"report.submit">): HelixTransition {
  const handoff = draft.handoffs.find(
    (candidate) => candidate.state === "running" || candidate.state === "dispatching",
  );
  if (!handoff) {
    return refuse(
      "no_running_handoff",
      "There is no running handoff to report on. Finish your turn.",
    );
  }
  if (handoff.epoch !== draft.pair.cancellationEpoch) {
    return refuse("stale_epoch", "This handoff was stopped. Finish your turn.", {
      handoffId: handoff.id,
    });
  }
  if (
    handoff.builderTurnId !== null &&
    command.builderTurnId !== null &&
    handoff.builderTurnId !== command.builderTurnId
  ) {
    return refuse("turn_mismatch", "This report comes from a different Builder turn.", {
      handoffId: handoff.id,
    });
  }
  // The handoff's turn is bound only from its brief's projected turn, never by
  // a caller: a report from another turn must not claim the handoff.
  draft.patchHandoff(handoff.id, {
    report: {
      ...command.report,
      reportRevision: (handoff.report?.reportRevision ?? 0) + 1,
      builderTurnId: command.builderTurnId,
      submittedAt: command.now,
    },
  });
  return draft.done(draft.handoff(handoff.id));
}

function turnSettled(draft: Draft, command: CommandOf<"turn.settled">): HelixTransition {
  const handoff = draft.handoff(command.handoffId);
  if (!handoff) return notFound(command.handoffId);
  if (handoff.state === "prepared") {
    return refuse("invalid_transition", "A prepared handoff has no Builder turn yet.", {
      handoffId: handoff.id,
    });
  }
  if (
    handoff.builderTurnId !== null &&
    command.builderTurnId !== null &&
    handoff.builderTurnId !== command.builderTurnId
  ) {
    return refuse("turn_mismatch", "This settlement is for a different Builder turn.", {
      handoffId: handoff.id,
    });
  }
  const result = buildResult(handoff, command);
  if (handoff.state !== "running" && handoff.state !== "dispatching") {
    // Already settled once: an identical replay changes nothing.
    if (handoff.result !== null && handoff.result.builderTurnId === result.builderTurnId) {
      return draft.unchanged(handoff);
    }
    // Stopped, cancelled or uncertain: keep the late result inspectable, never deliver it.
    if (handoff.lateResult !== null && handoff.lateResult.builderTurnId === result.builderTurnId) {
      return draft.unchanged(handoff);
    }
    draft.patchHandoff(handoff.id, {
      lateResult: result,
      lateResultReason:
        handoff.state === "uncertain"
          ? "uncertain_send"
          : handoff.epoch !== draft.pair.cancellationEpoch
            ? "stop"
            : "interrupted",
    });
    return draft.done(draft.handoff(handoff.id));
  }
  const state =
    command.turnOutcome === "completed"
      ? "awaiting_review"
      : command.turnOutcome === "failed"
        ? "failed"
        : "interrupted";
  draft.patchHandoff(handoff.id, {
    state,
    result,
    builderTurnId: handoff.builderTurnId ?? command.builderTurnId,
    delivery: draft.deliveryFor(handoff),
  });
  draft.emitDelivery(draft.handoff(handoff.id)!);
  return draft.done(draft.handoff(handoff.id));
}

function resultReturned(draft: Draft, command: CommandOf<"result.returned">): HelixTransition {
  const handoff = draft.handoff(command.handoffId);
  if (!handoff) return notFound(command.handoffId);
  if (handoff.delivery !== "pending") {
    return refuse(
      "invalid_transition",
      `The result is not awaiting delivery (it is ${handoff.delivery}).`,
      {
        handoffId: handoff.id,
      },
    );
  }
  draft.patchHandoff(handoff.id, { delivery: "returned_in_tool" });
  return draft.done(draft.handoff(handoff.id));
}

function wakeRequest(draft: Draft, command: CommandOf<"wake.request">): HelixTransition {
  const handoff = draft.handoff(command.handoffId);
  if (!handoff) return notFound(command.handoffId);
  // A reviewed handoff has nothing left to tell the Lead: close, never re-arm.
  if (handoff.review !== null) {
    if (handoff.delivery === "pending") {
      draft.patchHandoff(handoff.id, { delivery: "acknowledged" });
      return draft.done(draft.handoff(handoff.id));
    }
    return draft.unchanged(handoff);
  }
  if (handoff.delivery !== "pending") {
    return refuse(
      "invalid_transition",
      `The result is not awaiting delivery (it is ${handoff.delivery}).`,
      {
        handoffId: handoff.id,
      },
    );
  }
  const pair = draft.pair;
  if (pair.lifecycle !== "active") return refuse("pair_disabled", "Helix is off for this chat.");
  if (pair.hold !== null) return heldError(pair.hold);
  if (handoff.epoch !== pair.cancellationEpoch) {
    return refuse("stale_epoch", "This result belongs to a stopped run.", {
      handoffId: handoff.id,
    });
  }
  // Backstop: an automatic wake is attempted a bounded number of times. Past
  // it the result stays pending (helix_wait and helix_inspect still return
  // it) and the pair is held with a visible reason; nothing loops.
  if (handoff.wakeAttempts >= HELIX_MAX_WAKE_ATTEMPTS && command.afterResume !== true) {
    draft.setHold({
      kind: "uncertain",
      reason: `Helix could not wake the Lead with handoff ${handoff.sequence}'s result after ${HELIX_MAX_WAKE_ATTEMPTS} attempts. Ask the Lead to read it with helix_wait.`,
      limit: null,
      handoffId: handoff.id,
    });
    return draft.done(draft.handoff(handoff.id));
  }
  const attempt = handoff.wakeAttempts + 1;
  draft.patchHandoff(handoff.id, {
    delivery: "wake_requested",
    wakeAttempts: attempt,
    wake: {
      commandId: helixWakeCommandId(handoff.id, attempt),
      messageId: command.messageId,
      createdAt: command.now,
      attempt,
      ...(command.runtimeMode === undefined ? {} : { runtimeMode: command.runtimeMode }),
      ...(command.interactionMode === undefined
        ? {}
        : { interactionMode: command.interactionMode }),
    },
  });
  return draft.done(draft.handoff(handoff.id));
}

function wakeClosed(
  draft: Draft,
  command: CommandOf<"wake.dispatched" | "wake.suppressed">,
): HelixTransition {
  const handoff = draft.handoff(command.handoffId);
  if (!handoff) return notFound(command.handoffId);
  // The reactor may drop a wake it already accepted (queued behind a running
  // turn, then held): suppression applies to a dispatched wake as well.
  const closable =
    handoff.delivery === "wake_requested" ||
    (command.type === "wake.suppressed" && handoff.delivery === "wake_dispatched");
  if (handoff.wake?.commandId !== command.commandId || !closable) {
    return draft.unchanged(handoff);
  }
  if (command.type === "wake.dispatched") {
    draft.patchHandoff(handoff.id, { delivery: "wake_dispatched" });
    return draft.done(draft.handoff(handoff.id));
  }
  // Dropped before it ran: deliver again later if this run is still current
  // and the Lead has not reviewed it meanwhile (a review closes delivery).
  if (handoff.review !== null) {
    draft.patchHandoff(handoff.id, { delivery: "acknowledged", wake: null });
    return draft.done(draft.handoff(handoff.id));
  }
  const stillCurrent =
    handoff.epoch === draft.pair.cancellationEpoch &&
    draft.pair.hold?.kind !== "stop" &&
    draft.pair.lifecycle === "active";
  draft.patchHandoff(handoff.id, { delivery: stillCurrent ? "pending" : "suppressed", wake: null });
  return draft.done(draft.handoff(handoff.id));
}

/** Automatic wake attempts per handoff before the pair is held instead. */
export const HELIX_MAX_WAKE_ATTEMPTS = 5;

const REVIEWABLE_STATES = new Set(["awaiting_review", "failed", "interrupted"]);

function review(draft: Draft, command: CommandOf<"review">): HelixTransition {
  const handoff = draft.handoff(command.handoffId);
  if (!handoff) return notFound(command.handoffId);
  const feedback = command.feedback.trim();
  if (handoff.review !== null) {
    if (handoff.review.requestId !== command.requestId) {
      return refuse("invalid_transition", "This handoff was already reviewed.", {
        handoffId: handoff.id,
      });
    }
    return handoff.review.verdict === command.verdict && handoff.review.feedback === feedback
      ? draft.unchanged(handoff, { replayed: true })
      : refuse("request_conflict", "This review requestId already recorded a different verdict.", {
          handoffId: handoff.id,
        });
  }
  if (!REVIEWABLE_STATES.has(handoff.state)) {
    return refuse("invalid_transition", `A ${handoff.state} handoff cannot be reviewed.`, {
      handoffId: handoff.id,
    });
  }
  if (command.verdict === "accepted" && handoff.state !== "awaiting_review") {
    return refuse("invalid_transition", "Only a completed Builder result can be accepted.", {
      handoffId: handoff.id,
    });
  }
  if (command.verdict !== "accepted" && feedback.length === 0) {
    return refuse(
      "feedback_required",
      "Give one consolidated list of what must change or what blocks the work.",
      {
        handoffId: handoff.id,
      },
    );
  }
  const resultRevision = handoff.result?.revision ?? 0;
  if (
    command.expectedResultRevision !== undefined &&
    command.expectedResultRevision !== resultRevision
  ) {
    return refuse(
      "stale_result",
      "The Builder's result changed since you read it. Inspect it again.",
      {
        handoffId: handoff.id,
      },
    );
  }
  let nextHandoffId: HelixHandoffId | null = null;
  if (command.verdict === "changes_requested") {
    if (draft.pair.lifecycle !== "active")
      return refuse("pair_disabled", "Helix is off for this chat.");
    // Under a Stop nothing may queue Builder work the user did not ask for: a
    // non-user turn on the Lead (automation, goal, Hub) could otherwise create
    // a correction that a later Resume would run.
    if (draft.pair.hold?.kind === "stop") {
      return refuse(
        "pair_held",
        "The user stopped Helix. Accept or block this result, or wait for the user.",
        { handoffId: handoff.id, hold: draft.pair.hold },
      );
    }
    const active = draft.handoffs.find((candidate) => isHelixHandoffActive(candidate.state));
    if (active) {
      return refuse("handoff_active", "Another handoff is already prepared or running.", {
        handoffId: active.id,
      });
    }
    nextHandoffId = command.nextHandoffId;
  }
  draft.patchHandoff(handoff.id, {
    state: command.verdict,
    review: {
      requestId: command.requestId,
      verdict: command.verdict,
      feedback,
      reviewedResultRevision: resultRevision,
      nextHandoffId,
      reviewedAt: command.now,
    },
    // A review closes any unfinished delivery, including a wake still queued.
    delivery:
      handoff.delivery === "pending" ||
      handoff.delivery === "wake_requested" ||
      handoff.delivery === "wake_dispatched"
        ? "acknowledged"
        : handoff.delivery,
  });
  if (nextHandoffId === null) return draft.done(draft.handoff(handoff.id));

  const { correction: _previous, ...brief } = handoff.brief;
  const next = draft.insertHandoff({
    id: nextHandoffId,
    leadTurnId: command.leadTurnId ?? null,
    requestId: helixCorrectionRequestId(handoff.id),
    requestFingerprint: command.nextFingerprint,
    workItemId: handoff.workItemId,
    previousHandoffId: handoff.id,
    correctionIndex: handoff.correctionIndex + 1,
    brief: {
      ...brief,
      correction: {
        previousHandoffId: handoff.id,
        previousResultRevision: resultRevision,
        feedback,
      },
    },
  });
  if (next.correctionIndex > draft.pair.config.limits.maxCorrectionsPerWorkItem) {
    if (draft.pair.hold === null) {
      draft.setHold({
        kind: "limit",
        limit: "work_item_corrections",
        handoffId: next.id,
        reason: `This work item reached its limit of ${draft.pair.config.limits.maxCorrectionsPerWorkItem} corrections. Resume to allow one more round, or send a new message.`,
      });
    }
  } else {
    draft.admitDispatch(next);
  }
  return draft.done(draft.handoff(handoff.id));
}

/** The correction a changes_requested review created, after `transitionHelix` returned. */
export function helixCorrectionCreated(transition: HelixTransitionOk): HelixHandoff | null {
  const nextId = transition.handoff?.review?.nextHandoffId ?? null;
  if (nextId === null) return null;
  const write = transition.writes.find((candidate) => candidate.handoff.id === nextId);
  return write?.handoff ?? null;
}

function stop(draft: Draft): HelixTransition {
  const pair = draft.pair;
  if (pair.lifecycle !== "active") return draft.unchanged(null);
  const builderHadWork = draft.handoffs.some(
    (handoff) => handoff.state === "dispatching" || handoff.state === "running",
  );
  const epoch = pair.cancellationEpoch + 1;
  draft.patchPair({ cancellationEpoch: epoch });
  draft.setHold({ kind: "stop", reason: "Stopped by the user.", limit: null, handoffId: null });
  for (const handoff of draft.handoffs) {
    if (handoff.state === "prepared") {
      draft.patchHandoff(handoff.id, { state: "cancelled" });
    } else if (handoff.state === "dispatching" || handoff.state === "running") {
      draft.patchHandoff(handoff.id, {
        state: "interrupted",
        delivery: "suppressed",
        failure: { reason: "Stopped by the user.", at: draft.now },
      });
    } else if (handoff.delivery === "pending" || handoff.delivery === "wake_requested") {
      // A dispatched wake may already have run; a queued one is refused by the gate.
      draft.patchHandoff(handoff.id, { delivery: "suppressed" });
    }
  }
  draft.effect({
    type: "interrupt_participants",
    leadThreadId: pair.leadThreadId,
    builderThreadId: pair.builderThreadId,
    builderHadWork,
  });
  draft.effect({ type: "cancel_waits", epoch });
  return draft.done(null);
}

function pause(draft: Draft, command: RevisionedControl): HelixTransition {
  const stale = draft.refuseStale(command.expectedRevision);
  if (stale) return stale;
  if (draft.pair.lifecycle !== "active")
    return refuse("pair_disabled", "Helix is off for this chat.");
  if (draft.pair.hold?.kind === "pause") return draft.unchanged(null);
  if (draft.pair.hold !== null) return heldError(draft.pair.hold);
  draft.setHold({
    kind: "pause",
    reason: "Paused by the user. The current Builder turn continues; nothing new is dispatched.",
    limit: null,
    handoffId: null,
  });
  return draft.done(null);
}

function resume(draft: Draft, command: RevisionedControl): HelixTransition {
  const stale = draft.refuseStale(command.expectedRevision);
  if (stale) return stale;
  const pair = draft.pair;
  if (pair.lifecycle !== "active") return refuse("pair_disabled", "Helix is off for this chat.");
  if (pair.hold === null) return refuse("not_held", "Helix is not paused or stopped.");
  if (pair.hold.kind === "limit" && pair.hold.limit === "goal_dispatches") {
    const goal = pair.goal;
    draft.patchPair({
      goal: {
        ...goal,
        dispatchBudget:
          Math.max(goal.dispatchBudget, goal.dispatchCount) +
          pair.config.limits.maxDispatchesPerGoal,
      },
    });
  }
  draft.patchPair({ hold: null });
  draft.releaseHeldWork(true);
  return draft.done(null);
}

function disable(draft: Draft, command: RevisionedControl): HelixTransition {
  const stale = draft.refuseStale(command.expectedRevision);
  if (stale) return stale;
  if (draft.pair.lifecycle !== "active") return draft.unchanged(null);
  const active = draft.handoffs.find((handoff) => isHelixHandoffActive(handoff.state));
  if (active) {
    return refuse(
      "handoff_active",
      "Stop or finish the Builder's handoff before turning Helix off.",
      {
        handoffId: active.id,
      },
    );
  }
  const epoch = draft.pair.cancellationEpoch + 1;
  draft.patchPair({
    lifecycle: "disabled",
    hold: null,
    cancellationEpoch: epoch,
    config: { ...draft.pair.config, pendingChange: null },
  });
  for (const handoff of draft.handoffs) {
    if (handoff.delivery === "pending" || handoff.delivery === "wake_requested") {
      // A dispatched wake may already have run; a queued one is refused by the gate.
      draft.patchHandoff(handoff.id, { delivery: "suppressed" });
    }
  }
  draft.effect({ type: "cancel_waits", epoch });
  draft.effect({ type: "archive_builder_thread" });
  draft.effect({ type: "update_role_profiles" });
  return draft.done(null);
}

function enable(draft: Draft, command: RevisionedControl): HelixTransition {
  const stale = draft.refuseStale(command.expectedRevision);
  if (stale) return stale;
  if (draft.pair.lifecycle === "active") return draft.unchanged(null);
  const goal = draft.pair.goal;
  draft.patchPair({
    lifecycle: "active",
    hold: null,
    config: {
      ...draft.pair.config,
      pendingChange: null,
      ...(command.builderRuntimeMode === undefined
        ? {}
        : { builderRuntimeMode: command.builderRuntimeMode }),
    },
    goal: {
      ...goal,
      dispatchCount: 0,
      dispatchBudget: draft.pair.config.limits.maxDispatchesPerGoal,
    },
  });
  draft.effect({ type: "unarchive_builder_thread" });
  draft.effect({ type: "update_role_profiles" });
  return draft.done(null);
}

function configUpdate(draft: Draft, command: CommandOf<"config.update">): HelixTransition {
  const stale = draft.refuseStale(command.expectedRevision);
  if (stale) return stale;
  const busy = draft.handoffs.find(
    (handoff) => isHelixHandoffActive(handoff.state) || handoff.state === "awaiting_review",
  );
  if (busy) {
    return refuse("handoff_active", "Change the pair only while it is idle.", {
      handoffId: busy.id,
    });
  }
  if (command.builderModelSelection) {
    const support = helixRoleSupport(command.builderModelSelection.provider, "builder");
    if (!support.supported) return refuse("unsupported_provider", support.reason);
  }
  const config = draft.pair.config;
  draft.patchPair({
    config: {
      ...config,
      ...(command.builderModelSelection
        ? { builderModelSelection: command.builderModelSelection }
        : {}),
      ...(command.limits ? { limits: command.limits } : {}),
      ...(command.rolePromptVersions ? { rolePromptVersions: command.rolePromptVersions } : {}),
      // A Builder change supersedes a pending Builder change, never a pending "off".
      ...(command.builderModelSelection && config.pendingChange?.kind === "builder"
        ? { pendingChange: null }
        : {}),
    },
  });
  if (command.builderModelSelection) draft.effect({ type: "restart_builder_session" });
  return draft.done(null);
}

const USER_MESSAGE_RELEASES: ReadonlySet<HelixHold["kind"]> = new Set(["stop", "limit", "restart"]);

function userMessage(draft: Draft, command: CommandOf<"user_message">): HelixTransition {
  const pair = draft.pair;
  if (pair.lifecycle !== "active") return draft.unchanged(null);
  // The same message again (a retried command) starts no second goal.
  if (pair.goal.sourceMessageId === command.messageId) return draft.unchanged(null);
  const seq = pair.goal.seq + 1;
  draft.patchPair({
    goal: {
      seq,
      sourceMessageId: command.messageId,
      startedAt: command.now,
      dispatchCount: 0,
      dispatchBudget: pair.config.limits.maxDispatchesPerGoal,
    },
    ...(pair.hold !== null && USER_MESSAGE_RELEASES.has(pair.hold.kind) ? { hold: null } : {}),
  });
  // A plan prepared for an earlier goal is not authorised by the new message.
  for (const handoff of draft.handoffs) {
    if (handoff.state === "prepared" && handoff.goalSeq < seq) {
      draft.patchHandoff(handoff.id, { state: "cancelled" });
    }
  }
  for (const handoff of draft.handoffs) {
    if (handoff.delivery === "pending" && handoff.epoch === draft.pair.cancellationEpoch) {
      draft.emitDelivery(handoff);
    }
  }
  return draft.done(null);
}

function restartReconcile(draft: Draft, command: CommandOf<"restart.reconcile">): HelixTransition {
  let unresolved = false;
  let uncertainHandoff: HelixHandoffId | null = null;
  for (const handoff of draft.handoffs) {
    if (
      isHelixHandoffActive(handoff.state) ||
      handoff.delivery === "pending" ||
      handoff.delivery === "wake_requested"
    ) {
      unresolved = true;
    }
    if (handoff.state === "dispatching") {
      const evidence = command.evidence.get(handoff.id) ?? "send_uncertain";
      if (evidence === "not_sent") {
        draft.patchHandoff(handoff.id, { state: "prepared", dispatch: null });
        const goal = draft.pair.goal;
        draft.patchPair({ goal: { ...goal, dispatchCount: Math.max(0, goal.dispatchCount - 1) } });
      } else if (evidence === "turn_started") {
        // The turn exists: it settles once ingestion catches up, or the startup
        // turn reconciliation ends it; either way it is observed, never resent.
        draft.patchHandoff(handoff.id, { state: "running" });
      } else {
        draft.patchHandoff(handoff.id, {
          state: "uncertain",
          delivery: "suppressed",
          failure: {
            reason:
              "The server restarted while sending the brief; it may or may not have reached the Builder.",
            at: draft.now,
          },
        });
        uncertainHandoff = handoff.id;
      }
    }
    // A running handoff stays running: its turn may still settle when ingestion
    // catches up, and that real result is delivered once the user resumes. If it
    // never settles (ingestion stuck), the hold is visible and Stop closes it.
  }
  if (!unresolved || draft.pair.lifecycle !== "active") {
    return draft.changedAnything() ? draft.done(null) : draft.unchanged(null);
  }
  const hold = draft.pair.hold;
  if (hold?.kind !== "stop") {
    if (uncertainHandoff !== null) {
      draft.setHold({
        kind: "uncertain",
        reason:
          "The server restarted while sending a brief; it may or may not have reached the Builder. Helix will not resend it. Check the Builder thread, then resume.",
        limit: null,
        handoffId: uncertainHandoff,
      });
    } else if (hold === null) {
      draft.setHold({
        kind: "restart",
        reason: "The server restarted with Helix work unfinished. Resume to continue.",
        limit: null,
        handoffId: null,
      });
    }
  }
  return draft.done(null);
}

// ── Result composition ──────────────────────────────────────────────────

const NO_OUTPUT_SUMMARY = "The Builder's turn ended without a report or a final message.";

function buildResult(
  handoff: HelixHandoff,
  command: CommandOf<"turn.settled">,
): HelixBuilderResult {
  const revision = Math.max(handoff.result?.revision ?? 0, handoff.lateResult?.revision ?? 0) + 1;
  const builderTurnId = handoff.builderTurnId ?? command.builderTurnId;
  const base = {
    revision,
    turnOutcome: command.turnOutcome,
    builderTurnId,
    finalizedAt: command.now,
  };
  // A report counts only if it came from the turn that settled.
  const report =
    handoff.report !== null &&
    (handoff.report.builderTurnId === null ||
      builderTurnId === null ||
      handoff.report.builderTurnId === builderTurnId)
      ? handoff.report
      : null;
  if (report !== null) {
    const { reportRevision: _revision, builderTurnId: _turn, submittedAt: _at, ...fields } = report;
    return {
      ...base,
      ...fields,
      outcome:
        command.turnOutcome === "completed"
          ? report.outcome
          : command.turnOutcome === "failed"
            ? "failed"
            : "interrupted",
      source: "report",
    };
  }
  const finalMessage = command.finalMessage?.trim() ?? "";
  // Without a report the server cannot claim the work is complete.
  const outcome =
    command.turnOutcome === "completed"
      ? "partial"
      : command.turnOutcome === "failed"
        ? "failed"
        : "interrupted";
  return finalMessage.length > 0
    ? { ...base, outcome, source: "final_message", summary: finalMessage.slice(0, 16_000) }
    : { ...base, outcome, source: "none", summary: NO_OUTPUT_SUMMARY };
}

// ── Internals ───────────────────────────────────────────────────────────

function refuse(
  code: HelixTransitionErrorCode,
  message: string,
  extra?: { readonly handoffId?: HelixHandoffId; readonly hold?: HelixHold },
): { readonly ok: false; readonly error: HelixTransitionError } {
  return { ok: false, error: { code, message, ...extra } };
}

function notFound(handoffId: HelixHandoffId) {
  return refuse("handoff_not_found", "No such handoff in this pair.", { handoffId });
}

function heldError(hold: HelixHold) {
  return refuse("pair_held", hold.reason, { hold });
}

type HandoffPatch = Partial<
  Pick<
    HelixHandoff,
    | "state"
    | "delivery"
    | "dispatch"
    | "dispatchAttempts"
    | "builderTurnId"
    | "report"
    | "result"
    | "lateResult"
    | "review"
    | "wake"
    | "wakeAttempts"
    | "lateResultReason"
    | "failure"
  >
>;

/** Accumulates one transition's changes so revisions advance exactly once. */
class Draft {
  readonly now: string;
  private readonly original: HelixPair;
  private current: HelixPair;
  private readonly rows = new Map<HelixHandoffId, HelixHandoff>();
  private readonly originals = new Map<HelixHandoffId, HelixHandoff>();
  private readonly inserted = new Set<HelixHandoffId>();
  private readonly updated = new Set<HelixHandoffId>();
  private readonly effects: HelixEffect[] = [];
  private pairChanged = false;

  constructor(aggregate: HelixAggregate, now: string) {
    this.now = now;
    this.original = aggregate.pair;
    this.current = aggregate.pair;
    for (const handoff of aggregate.handoffs) {
      if (handoff.pairId !== aggregate.pair.id) continue;
      this.rows.set(handoff.id, handoff);
      this.originals.set(handoff.id, handoff);
    }
  }

  get pair(): HelixPair {
    return this.current;
  }

  get handoffs(): ReadonlyArray<HelixHandoff> {
    return [...this.rows.values()].toSorted((a, b) => a.sequence - b.sequence);
  }

  handoff(id: HelixHandoffId): HelixHandoff | undefined {
    return this.rows.get(id);
  }

  patchPair(patch: Partial<HelixPair>): void {
    this.current = { ...this.current, ...patch };
    this.pairChanged = true;
  }

  setHold(hold: Pick<HelixHold, "kind" | "reason" | "limit" | "handoffId">): void {
    this.patchPair({ hold: { ...hold, epoch: this.current.cancellationEpoch, since: this.now } });
  }

  patchHandoff(id: HelixHandoffId, patch: HandoffPatch): void {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.set(id, { ...row, ...patch });
    if (!this.inserted.has(id)) this.updated.add(id);
  }

  insertHandoff(input: {
    readonly id: HelixHandoffId;
    readonly requestId: string;
    readonly requestFingerprint: string;
    readonly workItemId: HelixHandoffId;
    readonly previousHandoffId: HelixHandoffId | null;
    readonly correctionIndex: number;
    readonly brief: HelixBrief;
    readonly leadTurnId?: TurnId | null;
  }): HelixHandoff {
    const sequence = Math.max(0, ...[...this.rows.values()].map((handoff) => handoff.sequence)) + 1;
    const { leadTurnId, ...fields } = input;
    const handoff: HelixHandoff = {
      ...fields,
      ...(leadTurnId != null ? { leadTurnId } : {}),
      pairId: this.current.id,
      sequence,
      goalSeq: this.current.goal.seq,
      epoch: this.current.cancellationEpoch,
      state: "prepared",
      delivery: "none",
      revision: 0,
      dispatch: null,
      dispatchAttempts: 0,
      builderTurnId: null,
      report: null,
      result: null,
      lateResult: null,
      review: null,
      wake: null,
      wakeAttempts: 0,
      failure: null,
      createdAt: this.now,
      updatedAt: this.now,
    };
    this.rows.set(handoff.id, handoff);
    this.inserted.add(handoff.id);
    this.pairChanged = true;
    return handoff;
  }

  effect(effect: HelixEffect): void {
    this.effects.push(effect);
  }

  /** Delivery for a result finalised now: pending in the current run, suppressed otherwise. */
  deliveryFor(handoff: HelixHandoff): HelixDeliveryState {
    return handoff.epoch === this.current.cancellationEpoch &&
      this.current.hold?.kind !== "stop" &&
      this.current.lifecycle === "active"
      ? "pending"
      : "suppressed";
  }

  emitDelivery(handoff: HelixHandoff, afterResume = false): void {
    if (handoff.delivery !== "pending") return;
    this.effect({
      type: "deliver_result",
      handoffId: handoff.id,
      wakeAllowed: this.current.hold === null && this.current.lifecycle === "active",
      ...(afterResume ? { afterResume: true } : {}),
    });
  }

  /** Emit dispatch for a prepared handoff, or hold the pair when the goal's budget is spent. */
  admitDispatch(handoff: HelixHandoff): void {
    const pair = this.current;
    if (
      pair.lifecycle !== "active" ||
      pair.hold !== null ||
      handoff.state !== "prepared" ||
      handoff.epoch !== pair.cancellationEpoch
    ) {
      return;
    }
    if (pair.goal.dispatchCount >= pair.goal.dispatchBudget) {
      this.setHold({
        kind: "limit",
        limit: "goal_dispatches",
        handoffId: handoff.id,
        reason: `This goal reached its limit of ${pair.config.limits.maxDispatchesPerGoal} Builder dispatches. Resume to allow more, or send a new message.`,
      });
      return;
    }
    this.effect({
      type: "dispatch_ready",
      handoffId: handoff.id,
      needsBuilderThread: pair.builderCreatedAt === null,
    });
  }

  /** After a hold is released: dispatch prepared work and deliver pending results of this run. */
  /** `afterResume`: an explicit Resume, which always means "try once more". */
  releaseHeldWork(afterResume = false): void {
    for (const handoff of this.handoffs) {
      if (handoff.state === "prepared") this.admitDispatch(handoff);
    }
    for (const handoff of this.handoffs) {
      if (handoff.delivery === "pending" && handoff.epoch === this.current.cancellationEpoch) {
        this.emitDelivery(handoff, afterResume);
      }
    }
  }

  refuseUnlessActiveAndFree(): ReturnType<typeof refuse> | null {
    if (this.current.lifecycle !== "active")
      return refuse("pair_disabled", "Helix is off for this chat.");
    if (this.current.hold !== null) return heldError(this.current.hold);
    const active = this.handoffs.find((handoff) => isHelixHandoffActive(handoff.state));
    if (active) {
      return refuse(
        "handoff_active",
        "The Builder already has a handoff. Wait for it with helix_wait and put further changes in your review.",
        { handoffId: active.id },
      );
    }
    return null;
  }

  refuseStale(expectedRevision: number): ReturnType<typeof refuse> | null {
    return expectedRevision === this.original.revision
      ? null
      : refuse(
          "stale_revision",
          `Helix changed since you loaded it (revision ${this.original.revision}). Reload and retry.`,
        );
  }

  changedAnything(): boolean {
    return this.pairChanged || this.updated.size > 0 || this.inserted.size > 0;
  }

  unchanged(
    handoff: HelixHandoff | null,
    options?: { readonly replayed?: boolean },
  ): HelixTransitionOk {
    return {
      ok: true,
      changed: false,
      replayed: options?.replayed === true,
      pair: this.original,
      expectedRevision: this.original.revision,
      writes: [],
      effects: [],
      handoff,
    };
  }

  done(handoff: HelixHandoff | null | undefined): HelixTransitionOk {
    if (!this.changedAnything()) return this.unchanged(handoff ?? null);
    const writes: HelixHandoffWrite[] = [];
    let primary: HelixHandoff | null = null;
    for (const handoff of this.handoffs) {
      if (this.inserted.has(handoff.id)) {
        writes.push({ kind: "insert", handoff });
      } else if (this.updated.has(handoff.id)) {
        const before = this.originals.get(handoff.id)!;
        const next = { ...handoff, revision: before.revision + 1, updatedAt: this.now };
        writes.push({ kind: "update", handoff: next, expectedRevision: before.revision });
      }
    }
    const final = (id: HelixHandoffId | undefined) =>
      id === undefined
        ? null
        : (writes.find((write) => write.handoff.id === id)?.handoff ?? this.rows.get(id) ?? null);
    primary = final(handoff?.id);
    return {
      ok: true,
      changed: true,
      replayed: false,
      pair: { ...this.current, revision: this.original.revision + 1, updatedAt: this.now },
      expectedRevision: this.original.revision,
      writes,
      effects: [...this.effects],
      handoff: primary,
    };
  }
}
