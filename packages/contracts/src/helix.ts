/**
 * Helix: an opt-in Lead/Builder pair inside one ordinary chat.
 *
 * The chat's own thread is the Lead. The server owns one persistent Builder
 * thread that works in the Lead's worktree with its own provider session. The
 * Lead delegates through server-hosted gateway tools; the server dispatches
 * each brief to the Builder, captures the Builder's report when its turn has
 * settled, and delivers it back to the Lead.
 *
 * Everything in this module is additive. Nothing here changes an existing
 * message an older client decodes: Helix state travels only over the
 * `helix.*` RPCs (served behind the `helix.pairs` capability), and the closed
 * unions below are new. Adding a literal to any of them later requires a new
 * capability string, because a client that predates it would fail to decode.
 *
 * Design: docs/plans/helix-prototype.md.
 *
 * @module helix
 */
import { Schema } from "effect";

import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import {
  ModelSelection,
  ProviderInteractionMode,
  type ProviderKind,
  RuntimeMode,
} from "./orchestration";

// ── Identity ────────────────────────────────────────────────────────────

export const HelixPairId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("HelixPairId"),
);
export type HelixPairId = typeof HelixPairId.Type;

/** At most 96 characters so derived request ids (`correction:<id>`) stay within 128. */
export const HelixHandoffId = TrimmedNonEmptyString.check(Schema.isMaxLength(96)).pipe(
  Schema.brand("HelixHandoffId"),
);
export type HelixHandoffId = typeof HelixHandoffId.Type;

/** Caller-chosen, stable per logical request. Reuse with identical content replays. */
export const HELIX_REQUEST_ID_MAX_LENGTH = 128;
export const HELIX_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const HelixRequestId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(HELIX_REQUEST_ID_MAX_LENGTH),
  Schema.isPattern(HELIX_REQUEST_ID_PATTERN),
);
export type HelixRequestId = typeof HelixRequestId.Type;

/** A participant's role. Resolved by the server from the pair tables, never from arguments. */
export const HelixRole = Schema.Literals(["lead", "builder"]);
export type HelixRole = typeof HelixRole.Type;

// ── Gateway surface ─────────────────────────────────────────────────────

/** Gateway capability every Lead credential carries in addition to its normal set. */
export const HELIX_LEAD_GATEWAY_CAPABILITY = "helix:lead";
/** The only gateway capability a Builder credential carries. */
export const HELIX_BUILDER_GATEWAY_CAPABILITY = "helix:builder";

export const HELIX_LEAD_TOOL_NAMES = [
  "helix_delegate",
  "helix_wait",
  "helix_inspect",
  "helix_review",
] as const;
export const HELIX_BUILDER_TOOL_NAMES = ["helix_report"] as const;
export const HELIX_TOOL_NAMES = [...HELIX_LEAD_TOOL_NAMES, ...HELIX_BUILDER_TOOL_NAMES] as const;
export type HelixToolName = (typeof HELIX_TOOL_NAMES)[number];

/** Default and maximum seconds `helix_delegate`, `helix_wait` and `helix_review` block. */
export const HELIX_DEFAULT_WAIT_SECONDS = 30;
export const HELIX_MAX_WAIT_SECONDS = 60;

// ── Limits ──────────────────────────────────────────────────────────────

export const HELIX_DEFAULT_MAX_CORRECTIONS_PER_WORK_ITEM = 3;
export const HELIX_DEFAULT_MAX_DISPATCHES_PER_GOAL = 20;

export const HelixLimits = Schema.Struct({
  /** Corrective handoffs (changes_requested) one work item may receive before dispatch pauses. */
  maxCorrectionsPerWorkItem: PositiveInt.check(Schema.isLessThanOrEqualTo(20)),
  /** Builder dispatches one user-initiated goal may consume before dispatch pauses. */
  maxDispatchesPerGoal: PositiveInt.check(Schema.isLessThanOrEqualTo(200)),
});
export type HelixLimits = typeof HelixLimits.Type;

export const DEFAULT_HELIX_LIMITS: HelixLimits = {
  maxCorrectionsPerWorkItem: HELIX_DEFAULT_MAX_CORRECTIONS_PER_WORK_ITEM,
  maxDispatchesPerGoal: HELIX_DEFAULT_MAX_DISPATCHES_PER_GOAL,
};

// ── Pair aggregate ──────────────────────────────────────────────────────

export const HelixPairLifecycle = Schema.Literals(["active", "disabled"]);
export type HelixPairLifecycle = typeof HelixPairLifecycle.Type;

/**
 * Why automatic dispatch and wakes are suppressed for a pair.
 *
 * - `stop`: a user Stop on either thread. Released by Resume or a new
 *   user-origin message to the Lead.
 * - `pause`: the user paused dispatch. Released by Resume only.
 * - `limit`: a loop limit was reached. Released by Resume (which grants another
 *   budget) or a new user-origin message to the Lead (a new goal).
 * - `restart`: the server restarted with unresolved work. Released by Resume or
 *   a new user-origin message to the Lead.
 * - `uncertain`: a Builder send may or may not have reached the provider.
 *   Released by Resume only; the send is never repeated.
 */
export const HelixHoldKind = Schema.Literals(["stop", "pause", "limit", "restart", "uncertain"]);
export type HelixHoldKind = typeof HelixHoldKind.Type;

export const HelixLimitKind = Schema.Literals(["goal_dispatches", "work_item_corrections"]);
export type HelixLimitKind = typeof HelixLimitKind.Type;

export const HelixHold = Schema.Struct({
  kind: HelixHoldKind,
  /** Human-readable explanation shown in the chat. */
  reason: Schema.String.check(Schema.isMaxLength(2_000)),
  /** Set only when `kind` is `limit`. */
  limit: Schema.NullOr(HelixLimitKind),
  /** The handoff that caused the hold, when one did. */
  handoffId: Schema.NullOr(HelixHandoffId),
  /** The pair's cancellation epoch when the hold was set. */
  epoch: NonNegativeInt,
  since: IsoDateTime,
});
export type HelixHold = typeof HelixHold.Type;

/** A user-initiated goal: every user-origin message to the Lead starts a new one. */
export const HelixGoal = Schema.Struct({
  /** 0 until the first user-origin message after the pair was enabled. */
  seq: NonNegativeInt,
  sourceMessageId: Schema.NullOr(MessageId),
  startedAt: Schema.NullOr(IsoDateTime),
  /** Builder dispatches started in this goal. */
  dispatchCount: NonNegativeInt,
  /** Dispatches allowed in this goal; Resume after a dispatch limit adds another window. */
  dispatchBudget: NonNegativeInt,
});
export type HelixGoal = typeof HelixGoal.Type;

export const HelixRolePromptVersions = Schema.Struct({
  lead: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  builder: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type HelixRolePromptVersions = typeof HelixRolePromptVersions.Type;

/**
 * A change a message asked for while the pair was busy, applied at its next
 * idle boundary (and before the next new delegation).
 */
export const HelixPendingChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("builder"), builderModelSelection: ModelSelection }),
  Schema.Struct({ kind: Schema.Literal("disable") }),
]);
export type HelixPendingChange = typeof HelixPendingChange.Type;

export const HelixPairConfig = Schema.Struct({
  /** Exact Builder selection. Never substituted; unsupported selections are refused. */
  builderModelSelection: ModelSelection,
  /** Copied from the Lead when the pair is enabled; Helix never escalates it. */
  builderRuntimeMode: RuntimeMode,
  limits: HelixLimits,
  /** Pinned while the pair is active; upgraded only at an idle boundary. */
  rolePromptVersions: HelixRolePromptVersions,
  /** Waiting for the pair to be idle. Optional for older servers. */
  pendingChange: Schema.optional(Schema.NullOr(HelixPendingChange)),
});
export type HelixPairConfig = typeof HelixPairConfig.Type;

export const HelixPair = Schema.Struct({
  id: HelixPairId,
  projectId: ProjectId,
  leadThreadId: ThreadId,
  /** Allocated when the pair is first enabled, before the thread exists. */
  builderThreadId: ThreadId,
  /** Null until the Builder thread has been created (lazily, on first dispatch). */
  builderCreatedAt: Schema.NullOr(IsoDateTime),
  lifecycle: HelixPairLifecycle,
  /** Optimistic-concurrency revision of the whole aggregate (pair and its handoffs). */
  revision: NonNegativeInt,
  /** Incremented by every Stop and by disable. Automatic work tagged with an older epoch is dropped. */
  cancellationEpoch: NonNegativeInt,
  hold: Schema.NullOr(HelixHold),
  goal: HelixGoal,
  config: HelixPairConfig,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HelixPair = typeof HelixPair.Type;

// ── Handoffs ────────────────────────────────────────────────────────────

/**
 * prepared → dispatching → running → awaiting_review → accepted, with the
 * explicit outcomes changes_requested, blocked, failed, interrupted,
 * cancelled and uncertain. Only prepared, dispatching and running occupy the
 * pair's single Builder slot.
 */
export const HelixHandoffState = Schema.Literals([
  "prepared",
  "dispatching",
  "running",
  "awaiting_review",
  "accepted",
  "changes_requested",
  "blocked",
  "failed",
  "interrupted",
  "cancelled",
  "uncertain",
]);
export type HelixHandoffState = typeof HelixHandoffState.Type;

export const HELIX_ACTIVE_HANDOFF_STATES = ["prepared", "dispatching", "running"] as const;
export const HELIX_TERMINAL_HANDOFF_STATES = [
  "accepted",
  "changes_requested",
  "blocked",
  "failed",
  "interrupted",
  "cancelled",
  "uncertain",
] as const;

export function isHelixHandoffActive(state: HelixHandoffState): boolean {
  return (HELIX_ACTIVE_HANDOFF_STATES as readonly string[]).includes(state);
}

export function isHelixHandoffTerminal(state: HelixHandoffState): boolean {
  return (HELIX_TERMINAL_HANDOFF_STATES as readonly string[]).includes(state);
}

/**
 * How a finalised Builder result reaches the Lead. Exactly one of
 * `returned_in_tool` or `wake_dispatched` happens per handoff.
 *
 * - `none`: no result yet.
 * - `pending`: finalised, not yet delivered.
 * - `returned_in_tool`: returned by a blocked `helix_delegate`/`helix_wait`/`helix_review`.
 * - `wake_requested`: a Lead wake turn was persisted (command id frozen).
 * - `wake_dispatched`: the engine accepted the wake turn.
 * - `acknowledged`: the Lead reviewed the handoff before any delivery.
 * - `suppressed`: the result belongs to a cancelled epoch; inspectable, never delivered.
 */
export const HelixDeliveryState = Schema.Literals([
  "none",
  "pending",
  "returned_in_tool",
  "wake_requested",
  "wake_dispatched",
  "acknowledged",
  "suppressed",
]);
export type HelixDeliveryState = typeof HelixDeliveryState.Type;

const BriefText = (max: number) => Schema.String.check(Schema.isMaxLength(max));

/** The correction a changes_requested review attaches to the next handoff. */
export const HelixBriefCorrection = Schema.Struct({
  previousHandoffId: HelixHandoffId,
  previousResultRevision: NonNegativeInt,
  feedback: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
});
export type HelixBriefCorrection = typeof HelixBriefCorrection.Type;

const HelixBriefFields = {
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  objective: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  /** Implementation decisions and established findings the Builder should reuse. */
  context: Schema.optional(BriefText(16_000)),
  scope: Schema.optional(BriefText(8_000)),
  constraints: Schema.optional(BriefText(8_000)),
  acceptanceCriteria: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  verification: Schema.optional(BriefText(8_000)),
  /** Background processes, dev servers and other runtime-state notes. */
  runtimeNotes: Schema.optional(BriefText(4_000)),
};

/** The brief a Lead writes in `helix_delegate`. */
export const HelixBriefInput = Schema.Struct(HelixBriefFields);
export type HelixBriefInput = typeof HelixBriefInput.Type;

/** A stored brief: the Lead's brief, plus the correction when a review created it. */
export const HelixBrief = Schema.Struct({
  ...HelixBriefFields,
  correction: Schema.optional(HelixBriefCorrection),
});
export type HelixBrief = typeof HelixBrief.Type;

export const HelixReportOutcome = Schema.Literals(["completed", "partial", "blocked", "failed"]);
export type HelixReportOutcome = typeof HelixReportOutcome.Type;

/** A Builder's `helix_report` draft. Finalised only when the Builder's turn has settled. */
export const HelixBuilderReport = Schema.Struct({
  outcome: HelixReportOutcome,
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)),
  changes: Schema.optional(BriefText(8_000)),
  verification: Schema.optional(BriefText(8_000)),
  deviations: Schema.optional(BriefText(4_000)),
  blockers: Schema.optional(BriefText(4_000)),
  followUps: Schema.optional(BriefText(4_000)),
});
export type HelixBuilderReport = typeof HelixBuilderReport.Type;

export const HelixStoredReport = Schema.Struct({
  ...HelixBuilderReport.fields,
  /** Incremented by each `helix_report` call in the same handoff; the last one wins. */
  reportRevision: PositiveInt,
  builderTurnId: Schema.NullOr(TurnId),
  submittedAt: IsoDateTime,
});
export type HelixStoredReport = typeof HelixStoredReport.Type;

export const HelixTurnOutcome = Schema.Literals(["completed", "failed", "interrupted"]);
export type HelixTurnOutcome = typeof HelixTurnOutcome.Type;

/**
 * A finalised Builder result: a candidate, not verified or accepted work.
 * `source` says whether it came from `helix_report` or, when the Builder never
 * reported, from its final assistant message.
 */
export const HelixBuilderResult = Schema.Struct({
  /** Result identity; reviews name the revision they reviewed. */
  revision: PositiveInt,
  turnOutcome: HelixTurnOutcome,
  outcome: Schema.Literals(["completed", "partial", "blocked", "failed", "interrupted"]),
  source: Schema.Literals(["report", "final_message", "none"]),
  summary: Schema.String.check(Schema.isMaxLength(16_000)),
  changes: Schema.optional(BriefText(8_000)),
  verification: Schema.optional(BriefText(8_000)),
  deviations: Schema.optional(BriefText(4_000)),
  blockers: Schema.optional(BriefText(4_000)),
  followUps: Schema.optional(BriefText(4_000)),
  builderTurnId: Schema.NullOr(TurnId),
  finalizedAt: IsoDateTime,
});
export type HelixBuilderResult = typeof HelixBuilderResult.Type;

export const HelixReviewVerdict = Schema.Literals(["accepted", "changes_requested", "blocked"]);
export type HelixReviewVerdict = typeof HelixReviewVerdict.Type;

/** The Lead's verdict. "Accepted" is the Lead's judgement only; it is not a human review mark. */
export const HelixReview = Schema.Struct({
  requestId: HelixRequestId,
  verdict: HelixReviewVerdict,
  feedback: Schema.String.check(Schema.isMaxLength(16_000)),
  reviewedResultRevision: NonNegativeInt,
  nextHandoffId: Schema.NullOr(HelixHandoffId),
  reviewedAt: IsoDateTime,
});
export type HelixReview = typeof HelixReview.Type;

/** A server-originated turn Helix asked the engine to run. Frozen so retries replay exactly. */
export const HelixTurnIntent = Schema.Struct({
  commandId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  messageId: MessageId,
  /** Reused verbatim as the command's createdAt: the receipt fingerprint includes it. */
  createdAt: IsoDateTime,
  attempt: PositiveInt,
  /** Frozen at the first attempt so a resend is the identical command. Optional for older rows. */
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
});
export type HelixTurnIntent = typeof HelixTurnIntent.Type;

export const HelixHandoffFailure = Schema.Struct({
  reason: Schema.String.check(Schema.isMaxLength(2_000)),
  at: IsoDateTime,
});
export type HelixHandoffFailure = typeof HelixHandoffFailure.Type;

/** Why a result was kept as `lateResult` instead of being delivered. */
export const HelixLateResultReason = Schema.Literals(["stop", "uncertain_send", "interrupted"]);
export type HelixLateResultReason = typeof HelixLateResultReason.Type;

export const HelixHandoff = Schema.Struct({
  id: HelixHandoffId,
  pairId: HelixPairId,
  /** 1-based, per pair. */
  sequence: PositiveInt,
  requestId: HelixRequestId,
  /** Digest of the request content; same requestId with another fingerprint is a conflict. */
  requestFingerprint: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** The first handoff of a work item; corrections share it. */
  workItemId: HelixHandoffId,
  previousHandoffId: Schema.NullOr(HelixHandoffId),
  /** 0 for the original brief, n for the nth correction of the work item. */
  correctionIndex: NonNegativeInt,
  goalSeq: NonNegativeInt,
  /** Pair cancellation epoch at creation. */
  epoch: NonNegativeInt,
  state: HelixHandoffState,
  delivery: HelixDeliveryState,
  revision: NonNegativeInt,
  brief: HelixBrief,
  dispatch: Schema.NullOr(HelixTurnIntent),
  /** Dispatch attempts consumed, including ones a hold suppressed before the provider send. */
  dispatchAttempts: NonNegativeInt,
  builderTurnId: Schema.NullOr(TurnId),
  report: Schema.NullOr(HelixStoredReport),
  result: Schema.NullOr(HelixBuilderResult),
  /** A result that arrived after the handoff was stopped or otherwise closed. Never delivered. */
  lateResult: Schema.NullOr(HelixBuilderResult),
  /** Set with `lateResult`. Optional: absent on rows written before it existed. */
  lateResultReason: Schema.optional(HelixLateResultReason),
  /**
   * The Lead turn that created this handoff (helix_delegate, or the review that
   * requested the correction): the anchor for placing it in the Lead's timeline.
   * Optional: absent on rows written before it existed.
   */
  leadTurnId: Schema.optional(Schema.NullOr(TurnId)),
  review: Schema.NullOr(HelixReview),
  wake: Schema.NullOr(HelixTurnIntent),
  wakeAttempts: NonNegativeInt,
  failure: Schema.NullOr(HelixHandoffFailure),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HelixHandoff = typeof HelixHandoff.Type;

/**
 * Why a participant guard refused a client command. Sent as `WsRpcError.reason`
 * next to `code: HELIX_UNSUPPORTED_THREAD`; older clients ignore it.
 */
export const HelixRefusalReason = Schema.Literals([
  /** A hand off of a chat in an active pair. */
  "pair_active",
  /** A message typed into a Builder, or any use of a former (retired) Builder. */
  "builder_read_only",
  /** Archive, unarchive or delete of a Builder that follows its Lead. */
  "builder_follows_lead",
  "builder_workspace_fixed",
  "builder_model_in_settings",
  "lead_workspace_locked",
  "lead_provider_unsupported",
  /** A revert while the Builder works (a handoff in flight or its session busy). */
  "revert_builder_busy",
  /** A revert of the Builder while the Lead works. */
  "revert_lead_busy",
  /** Helix could not confirm the shared workspace is idle. */
  "revert_unknown",
  /** A git hand off whose working directory is a pair's shared workspace. */
  "workspace_in_pair",
]);
export type HelixRefusalReason = typeof HelixRefusalReason.Type;

/** A pair whose stored data does not decode. Listed so the user can remove it. */
export const HelixQuarantinedPair = Schema.Struct({
  pairId: Schema.String,
  leadThreadId: Schema.String,
  builderThreadId: Schema.String,
  reason: Schema.String,
});
export type HelixQuarantinedPair = typeof HelixQuarantinedPair.Type;

// ── Display status (shared by server and web) ───────────────────────────

export const HelixPairDisplayStatus = Schema.Literals([
  "idle",
  "building",
  "reviewing",
  "needs_attention",
  "paused",
  "stopped",
  "disabled",
]);
export type HelixPairDisplayStatus = typeof HelixPairDisplayStatus.Type;

/**
 * The status chip for a pair. `latest` is the pair's highest-sequence handoff.
 * The web combines `idle` with the Lead thread's own running state to show
 * "Planning".
 */
export function helixPairDisplayStatus(
  pair: Pick<HelixPair, "lifecycle" | "hold">,
  latest: Pick<HelixHandoff, "state"> | null,
): HelixPairDisplayStatus {
  if (pair.lifecycle === "disabled") return "disabled";
  if (pair.hold?.kind === "stop") return "stopped";
  if (pair.hold?.kind === "pause") return "paused";
  if (pair.hold !== null) return "needs_attention";
  if (latest === null) return "idle";
  if (isHelixHandoffActive(latest.state)) return "building";
  if (latest.state === "awaiting_review") return "reviewing";
  if (latest.state === "blocked" || latest.state === "uncertain") return "needs_attention";
  return "idle";
}

// ── Provider qualification ──────────────────────────────────────────────

export type HelixRoleSupport =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string };

const HELIX_SUPPORTED_PROVIDERS: ReadonlySet<ProviderKind> = new Set(["codex", "claudeAgent"]);

const HELIX_UNSUPPORTED_REASONS: Readonly<Record<ProviderKind, string>> = {
  codex: "",
  claudeAgent: "",
  cursor:
    "Unsupported in this version: Helix role instructions and the scoped Helix tools are qualified only for Claude and Codex.",
  antigravity:
    "Unsupported in this version: Antigravity runs only with full access and has no approval requests or steering.",
  grok: "Unsupported in this version: Helix role instructions and the scoped Helix tools are qualified only for Claude and Codex.",
  droid:
    "Unsupported in this version: Droid's appended system prompt and queued steering are not yet qualified for Helix.",
  opencode:
    "Unsupported in this version: OpenCode needs a Synara-managed server for the Helix tools, which is not yet qualified.",
  pi: "Unsupported in this version: Pi does not raise approval requests, so Helix cannot preserve permissions.",
  devin:
    "Unsupported in this version: Devin's native delegation cannot be suppressed for a Helix role.",
  omp: "Unsupported in this version: OMP's native delegation cannot be suppressed for a Helix role.",
};

/**
 * Whether a provider may take a Helix role. Claude and Codex only, for both
 * roles, in the prototype. Never substitute another provider when this
 * returns unsupported.
 */
export function helixRoleSupport(provider: ProviderKind, _role: HelixRole): HelixRoleSupport {
  if (HELIX_SUPPORTED_PROVIDERS.has(provider)) return { supported: true };
  return {
    supported: false,
    reason:
      HELIX_UNSUPPORTED_REASONS[provider] ||
      "Unsupported in this version: this provider is not qualified for Helix.",
  };
}

// ── Gateway tool inputs and outputs ─────────────────────────────────────

const WaitSeconds = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(HELIX_MAX_WAIT_SECONDS),
);

export const HelixDelegateToolInput = Schema.Struct({
  requestId: HelixRequestId,
  brief: HelixBriefInput,
  waitSeconds: Schema.optional(WaitSeconds),
});
export type HelixDelegateToolInput = typeof HelixDelegateToolInput.Type;

export const HelixWaitToolInput = Schema.Struct({
  /** Defaults to the pair's active handoff, else its latest handoff. */
  handoffId: Schema.optional(HelixHandoffId),
  waitSeconds: Schema.optional(WaitSeconds),
});
export type HelixWaitToolInput = typeof HelixWaitToolInput.Type;

export const HelixInspectToolInput = Schema.Struct({
  handoffId: Schema.optional(HelixHandoffId),
  /** Number of recent handoffs to summarise, newest first. */
  recent: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(20)),
  ),
});
export type HelixInspectToolInput = typeof HelixInspectToolInput.Type;

export const HelixReviewToolInput = Schema.Struct({
  handoffId: HelixHandoffId,
  requestId: HelixRequestId,
  verdict: HelixReviewVerdict,
  /** Required for changes_requested and blocked: one consolidated list of what must change. */
  feedback: Schema.optional(Schema.String.check(Schema.isMaxLength(16_000))),
  /** When given, the review is refused if the result changed since the Lead read it. */
  expectedResultRevision: Schema.optional(PositiveInt),
  /** Wait for the correction handoff's result (changes_requested only). */
  waitSeconds: Schema.optional(WaitSeconds),
});
export type HelixReviewToolInput = typeof HelixReviewToolInput.Type;

export const HelixReportToolInput = HelixBuilderReport;
export type HelixReportToolInput = typeof HelixReportToolInput.Type;

/** The compact handoff view tools return. Briefs are omitted; `helix_inspect` returns them. */
export const HelixHandoffToolView = Schema.Struct({
  handoffId: HelixHandoffId,
  sequence: PositiveInt,
  title: Schema.String,
  state: HelixHandoffState,
  delivery: HelixDeliveryState,
  correctionIndex: NonNegativeInt,
  workItemId: HelixHandoffId,
  result: Schema.NullOr(HelixBuilderResult),
  review: Schema.NullOr(HelixReview),
  failure: Schema.NullOr(HelixHandoffFailure),
});
export type HelixHandoffToolView = typeof HelixHandoffToolView.Type;

/** Result of `helix_delegate`, `helix_wait` and a changes_requested `helix_review`. */
export const HelixHandoffWaitOutput = Schema.Struct({
  pairId: HelixPairId,
  handoff: HelixHandoffToolView,
  /** True when the request matched an existing handoff with identical content. */
  replayed: Schema.Boolean,
  /** True when the wait ended before the result was ready; the Builder keeps working. */
  timedOut: Schema.Boolean,
  hold: Schema.NullOr(HelixHold),
  message: Schema.String,
});
export type HelixHandoffWaitOutput = typeof HelixHandoffWaitOutput.Type;

export const HelixInspectToolOutput = Schema.Struct({
  pairId: HelixPairId,
  builderThreadId: ThreadId,
  status: HelixPairDisplayStatus,
  hold: Schema.NullOr(HelixHold),
  goal: HelixGoal,
  limits: HelixLimits,
  handoff: Schema.NullOr(
    Schema.Struct({
      ...HelixHandoffToolView.fields,
      brief: HelixBrief,
      report: Schema.NullOr(HelixStoredReport),
    }),
  ),
  recent: Schema.Array(HelixHandoffToolView),
});
export type HelixInspectToolOutput = typeof HelixInspectToolOutput.Type;

export const HelixReviewToolOutput = Schema.Struct({
  pairId: HelixPairId,
  handoffId: HelixHandoffId,
  verdict: HelixReviewVerdict,
  replayed: Schema.Boolean,
  /** The correction handoff a changes_requested verdict created, with its wait outcome. */
  next: Schema.NullOr(HelixHandoffWaitOutput),
  hold: Schema.NullOr(HelixHold),
  message: Schema.String,
});
export type HelixReviewToolOutput = typeof HelixReviewToolOutput.Type;

export const HelixReportToolOutput = Schema.Struct({
  handoffId: HelixHandoffId,
  reportRevision: PositiveInt,
  message: Schema.String,
});
export type HelixReportToolOutput = typeof HelixReportToolOutput.Type;

/**
 * `error.code` values in Helix tool error results (MCP `isError` payloads).
 * Not part of `SynaraGatewayErrorCode`; no client decodes them with a schema.
 */
export const HELIX_TOOL_ERROR_CODES = [
  "helix_disabled",
  "helix_not_implemented",
  "helix_invalid_input",
  "helix_no_pair",
  "helix_pair_disabled",
  "helix_pair_held",
  "helix_handoff_active",
  "helix_review_pending",
  "helix_request_conflict",
  "helix_handoff_not_found",
  "helix_invalid_transition",
  "helix_stale_result",
  "helix_feedback_required",
  "helix_no_running_handoff",
] as const;
export type HelixToolErrorCode = (typeof HELIX_TOOL_ERROR_CODES)[number];

// ── Session start: role instructions for provider adapters ─────────────

/**
 * Role context the server puts on `ProviderSessionStartInput.helixRole` when
 * it starts or resumes a Helix participant's session. Adapters append
 * `instructions` through their native instruction channel and use `role` to
 * vary provider-native delegation guidance. It carries no authority: gateway
 * capabilities come from the server-side credential.
 */
export const ProviderHelixRoleContext = Schema.Struct({
  role: HelixRole,
  pairId: HelixPairId,
  promptVersion: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  instructions: TrimmedNonEmptyString.check(Schema.isMaxLength(16_000)),
});
export type ProviderHelixRoleContext = typeof ProviderHelixRoleContext.Type;

// ── RPC payloads ────────────────────────────────────────────────────────

export const HELIX_WS_METHODS = {
  capabilities: "helix.capabilities",
  listPairs: "helix.listPairs",
  getPair: "helix.getPair",
  enable: "helix.enable",
  disable: "helix.disable",
  updateConfig: "helix.updateConfig",
  pause: "helix.pause",
  resume: "helix.resume",
  stop: "helix.stop",
  removePair: "helix.removePair",
  subscribe: "helix.subscribe",
} as const;

/** Server capability advertised in negotiation when the helix.* RPCs are served. */
export const WS_HELIX_PAIRS_CAPABILITY = "helix.pairs";
/**
 * Server capability: user messages (`thread.turn.start`, `thread.message.edit-and-resend`)
 * may carry `helix: HelixMessagePairing`. Clients never send the field otherwise.
 */
export const WS_HELIX_MESSAGE_PAIRING_CAPABILITY = "helix.message-pairing";

// Defined next to the commands that carry them (no import cycle); exported here too.
export {
  HelixMessagePairing,
  HelixPairingNotAppliedReason,
  HelixPairingOutcome,
} from "./orchestration";

/** `WsRpcError.code` values the helix.* RPCs fail with. */
export const HELIX_RPC_ERROR_CODES = {
  disabled: "HELIX_DISABLED",
  unavailable: "HELIX_UNAVAILABLE",
  notImplemented: "HELIX_NOT_IMPLEMENTED",
  notFound: "HELIX_NOT_FOUND",
  staleRevision: "HELIX_STALE_REVISION",
  conflict: "HELIX_CONFLICT",
  invalidTransition: "HELIX_INVALID_TRANSITION",
  unsupportedProvider: "HELIX_UNSUPPORTED_PROVIDER",
  unsupportedThread: "HELIX_UNSUPPORTED_THREAD",
  pairBusy: "HELIX_PAIR_BUSY",
} as const;
export type HelixRpcErrorCode = (typeof HELIX_RPC_ERROR_CODES)[keyof typeof HELIX_RPC_ERROR_CODES];

export const HelixProviderSupport = Schema.Struct({
  provider: Schema.String,
  lead: Schema.Struct({ supported: Schema.Boolean, reason: Schema.NullOr(Schema.String) }),
  builder: Schema.Struct({ supported: Schema.Boolean, reason: Schema.NullOr(Schema.String) }),
});
export type HelixProviderSupport = typeof HelixProviderSupport.Type;

export const HelixCapabilitiesInput = Schema.Struct({});
export const HelixCapabilitiesResult = Schema.Struct({
  /** The `enableHelix` server setting. */
  enabled: Schema.Boolean,
  providers: Schema.Array(HelixProviderSupport),
  defaultLimits: HelixLimits,
});
export type HelixCapabilitiesResult = typeof HelixCapabilitiesResult.Type;

export const HelixPairSummary = Schema.Struct({
  pairId: HelixPairId,
  projectId: ProjectId,
  leadThreadId: ThreadId,
  builderThreadId: ThreadId,
  lifecycle: HelixPairLifecycle,
  status: HelixPairDisplayStatus,
  hold: Schema.NullOr(HelixHold),
  activeHandoffId: Schema.NullOr(HelixHandoffId),
  /** State of the highest-sequence handoff; null before the first. Optional for older servers. */
  latestHandoffState: Schema.optional(Schema.NullOr(HelixHandoffState)),
  /** Why the highest-sequence handoff failed or was interrupted, for the composer banner. */
  latestHandoffFailure: Schema.optional(Schema.NullOr(Schema.String)),
  /** When that handoff last changed (e.g. "finished" time). */
  latestHandoffUpdatedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** A change waiting for the pair to be idle (from a message's pairing). */
  pendingChange: Schema.optional(Schema.NullOr(HelixPendingChange)),
  revision: NonNegativeInt,
  updatedAt: IsoDateTime,
});
export type HelixPairSummary = typeof HelixPairSummary.Type;

export const HELIX_PAIR_VIEW_MAX_HANDOFFS = 50;

export const HelixPairView = Schema.Struct({
  summary: HelixPairSummary,
  pair: HelixPair,
  /** Newest first, at most HELIX_PAIR_VIEW_MAX_HANDOFFS. */
  handoffs: Schema.Array(HelixHandoff),
});
export type HelixPairView = typeof HelixPairView.Type;

export const HelixListPairsInput = Schema.Struct({});
export const HelixListPairsResult = Schema.Struct({
  pairs: Schema.Array(HelixPairSummary),
  /** Pairs whose data could not be read; remove them with `helix.removePair`. Optional for older servers. */
  quarantined: Schema.optional(Schema.Array(HelixQuarantinedPair)),
});
export type HelixListPairsResult = typeof HelixListPairsResult.Type;

export const HelixGetPairInput = Schema.Struct({ leadThreadId: ThreadId });
export type HelixGetPairInput = typeof HelixGetPairInput.Type;
export const HelixGetPairResult = Schema.NullOr(HelixPairView);
export type HelixGetPairResult = typeof HelixGetPairResult.Type;

export const HelixEnableInput = Schema.Struct({
  leadThreadId: ThreadId,
  builderModelSelection: ModelSelection,
  limits: Schema.optional(HelixLimits),
  /** Required when re-enabling a disabled pair: its current revision. Omit for a new pair. */
  expectedRevision: Schema.optional(NonNegativeInt),
});
export type HelixEnableInput = typeof HelixEnableInput.Type;

/** Pause, resume and disable carry the revision the client last saw. */
export const HelixPairControlInput = Schema.Struct({
  pairId: HelixPairId,
  expectedRevision: NonNegativeInt,
});
export type HelixPairControlInput = typeof HelixPairControlInput.Type;

/**
 * Remove a pair outright by id, without reading its data: the way out for a
 * quarantined pair. The Builder thread is archived and both chats lose every
 * Helix role and guard. Owner only.
 */
export const HelixRemovePairInput = Schema.Struct({ pairId: Schema.String });
export type HelixRemovePairInput = typeof HelixRemovePairInput.Type;
export const HelixRemovePairResult = Schema.Struct({
  pairId: Schema.String,
  removed: Schema.Boolean,
});
export type HelixRemovePairResult = typeof HelixRemovePairResult.Type;

/** Stop always wins: it takes no expected revision. */
export const HelixStopInput = Schema.Struct({ pairId: HelixPairId });
export type HelixStopInput = typeof HelixStopInput.Type;

export const HelixUpdateConfigInput = Schema.Struct({
  pairId: HelixPairId,
  expectedRevision: NonNegativeInt,
  builderModelSelection: Schema.optional(ModelSelection),
  limits: Schema.optional(HelixLimits),
});
export type HelixUpdateConfigInput = typeof HelixUpdateConfigInput.Type;

export const HelixSubscribeInput = Schema.Struct({
  /** Scope handoff events to one Lead thread. Pair events are always global. */
  leadThreadId: Schema.optional(ThreadId),
});
export type HelixSubscribeInput = typeof HelixSubscribeInput.Type;

export const HelixStreamEvent = Schema.Union([
  /** First event on every subscription. `view` is present when scoped to a Lead thread with a pair. */
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    pairs: Schema.Array(HelixPairSummary),
    view: Schema.NullOr(HelixPairView),
    quarantined: Schema.optional(Schema.Array(HelixQuarantinedPair)),
  }),
  /** After every committed pair transition. */
  Schema.Struct({ type: Schema.Literal("pair-upserted"), summary: HelixPairSummary }),
  /** After every committed handoff change; only on subscriptions scoped to that pair's Lead. */
  Schema.Struct({ type: Schema.Literal("handoff-upserted"), handoff: HelixHandoff }),
  /** The pair row was deleted (its Lead thread was deleted). */
  Schema.Struct({
    type: Schema.Literal("pair-removed"),
    pairId: HelixPairId,
    leadThreadId: ThreadId,
    builderThreadId: ThreadId,
  }),
]);
export type HelixStreamEvent = typeof HelixStreamEvent.Type;
