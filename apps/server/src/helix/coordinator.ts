/**
 * The Helix coordinator: drives pairs through the pure state machine, commits
 * every transition, publishes it, and performs the resulting effects against
 * the orchestration engine (docs/plans/helix-prototype.md, sections 5-8).
 *
 * Shape of every change: under a per-pair lock, load the aggregate, apply one
 * command, commit with the pair revision as guard, publish stream events;
 * then, after the lock is released, perform the effects. Effects never run
 * under a lock, and every effect is either idempotent (deterministic command
 * ids with frozen timestamps) or guarded by a state-machine compare-and-set,
 * so a crash or retry can repeat any step without duplicating work.
 *
 * @module helix/coordinator
 */
import {
  CommandId,
  DEFAULT_HELIX_LIMITS,
  HELIX_PAIR_VIEW_MAX_HANDOFFS,
  HELIX_RPC_ERROR_CODES,
  HELIX_DEFAULT_WAIT_SECONDS,
  ProviderKind,
  ThreadId,
  helixRoleSupport,
  isHelixHandoffActive,
  type HelixCapabilitiesResult,
  type HelixHandoff,
  type HelixHandoffId,
  type HelixHandoffWaitOutput,
  type HelixHold,
  type HelixInspectToolOutput,
  type HelixPair,
  type HelixPairId,
  type HelixReportToolOutput,
  type HelixReviewToolOutput,
  type HelixRole,
  type HelixRpcErrorCode,
  type HelixStreamEvent,
  type HelixToolErrorCode,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type ProviderHelixRoleContext,
  type RuntimeMode,
  type TurnId,
  type HelixRefusalReason,
  type HelixQuarantinedPair,
  type HelixPairSummary,
  type HelixRemovePairResult,
  type HelixMessagePairing,
  type HelixPairingOutcome,
  type HelixPendingChange,
} from "@synara/contracts";
import { randomUUID } from "node:crypto";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Fiber,
  PubSub,
  Queue,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import type { AgentGatewayRoleProfile } from "../agentGateway/Services/AgentGatewaySessionRegistry.ts";
import {
  HelixRepositoryError,
  type HelixRepositoryShape,
} from "../persistence/Services/HelixRepository.ts";
import { helixRequestFingerprint, newHelixHandoffId, newHelixPairId } from "./identity.ts";
import {
  helixBriefMessageId,
  helixWakeMessageId,
  parseHelixMessageId,
  renderHelixBrief,
  renderHelixLeadWake,
} from "./messages.ts";
import { HELIX_ROLE_PROMPT_VERSION, renderHelixRoleInstructions } from "./rolePrompts.ts";
import { HelixRuntimeError, type HelixRuntimeShape } from "./runtime.ts";
import type { HelixGatewayPortShape, HelixToolCaller } from "./Services/HelixGatewayPort.ts";
import { HelixServiceError, type HelixServiceShape } from "./Services/HelixService.ts";
import {
  createHelixPair,
  helixCorrectionCreated,
  transitionHelix,
  type HelixAggregate,
  type HelixCommand,
  type HelixEffect,
  type HelixRestartEvidence,
  type HelixTransitionError,
  type HelixTransitionOk,
} from "./stateMachine.ts";
import { helixHandoffToolView, helixPairSummary, helixPairView } from "./views.ts";
import { GatewayToolError } from "../agentGateway/toolRuntime.ts";

// ── Errors ──────────────────────────────────────────────────────────────

export class HelixCoordinatorError extends Schema.TaggedErrorClass<HelixCoordinatorError>()(
  "HelixCoordinatorError",
  {
    reason: Schema.Literals([
      "transition",
      "disabled",
      "not_found",
      "not_participant",
      "unsupported_thread",
      "unsupported_provider",
      "storage",
    ]),
    /** The state machine's code when `reason` is `transition`. */
    code: Schema.optional(Schema.String),
    message: Schema.String,
    handoffId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {}

const refuse = (reason: HelixCoordinatorError["reason"], message: string) =>
  new HelixCoordinatorError({ reason, message });

const fromTransition = (error: HelixTransitionError) =>
  new HelixCoordinatorError({
    reason: "transition",
    code: error.code,
    message: error.message,
    ...(error.handoffId === undefined ? {} : { handoffId: error.handoffId }),
  });

const storage = (message: string) => (cause: unknown) =>
  cause instanceof HelixCoordinatorError
    ? cause
    : new HelixCoordinatorError({ reason: "storage", message, cause });

export function helixRpcErrorCode(error: HelixCoordinatorError): HelixRpcErrorCode {
  switch (error.reason) {
    case "disabled":
      return HELIX_RPC_ERROR_CODES.disabled;
    case "not_found":
    case "not_participant":
      return HELIX_RPC_ERROR_CODES.notFound;
    case "unsupported_thread":
      return HELIX_RPC_ERROR_CODES.unsupportedThread;
    case "unsupported_provider":
      return HELIX_RPC_ERROR_CODES.unsupportedProvider;
    case "storage":
      return HELIX_RPC_ERROR_CODES.unavailable;
    case "transition":
      switch (error.code) {
        case "stale_revision":
          return HELIX_RPC_ERROR_CODES.staleRevision;
        case "pair_held":
        case "handoff_active":
          return HELIX_RPC_ERROR_CODES.pairBusy;
        case "unsupported_provider":
          return HELIX_RPC_ERROR_CODES.unsupportedProvider;
        case "request_conflict":
          return HELIX_RPC_ERROR_CODES.conflict;
        case "handoff_not_found":
          return HELIX_RPC_ERROR_CODES.notFound;
        default:
          return HELIX_RPC_ERROR_CODES.invalidTransition;
      }
  }
}

const TRANSITION_TOOL_CODES: Readonly<Record<string, HelixToolErrorCode>> = {
  pair_held: "helix_pair_held",
  handoff_active: "helix_handoff_active",
  review_pending: "helix_review_pending",
  request_conflict: "helix_request_conflict",
  handoff_not_found: "helix_handoff_not_found",
  stale_result: "helix_stale_result",
  feedback_required: "helix_feedback_required",
  no_running_handoff: "helix_no_running_handoff",
  pair_disabled: "helix_pair_disabled",
};

export function helixToolErrorCode(error: HelixCoordinatorError): HelixToolErrorCode {
  switch (error.reason) {
    case "disabled":
      return "helix_disabled";
    case "not_found":
    case "not_participant":
    case "unsupported_thread":
      return "helix_no_pair";
    case "transition":
      return TRANSITION_TOOL_CODES[error.code ?? ""] ?? "helix_invalid_transition";
    default:
      return "helix_invalid_transition";
  }
}

const asCoordinatorError = (error: unknown): HelixCoordinatorError =>
  error instanceof HelixCoordinatorError
    ? error
    : storage("Helix could not reach the orchestration engine.")(error);

const toServiceError = (cause: unknown) => {
  const error = asCoordinatorError(cause);
  return HelixServiceError.of(helixRpcErrorCode(error), error.message, error.cause);
};

const toToolError = (cause: unknown) => {
  const error = asCoordinatorError(cause);
  return new GatewayToolError(helixToolErrorCode(error), error.message, {
    ...(error.code === undefined ? {} : { reason: error.code }),
    ...(error.handoffId === undefined ? {} : { handoffId: error.handoffId }),
  });
};

// ── Dependencies and hooks ──────────────────────────────────────────────

export interface HelixCoordinatorDeps {
  readonly repository: HelixRepositoryShape;
  readonly runtime: HelixRuntimeShape;
  /** The `enableHelix` server setting. */
  readonly isEnabled: Effect.Effect<boolean>;
  /** Apply a gateway role profile (`AgentGatewayCredentials.setThreadRoleProfile`). */
  readonly setRoleProfile?: (threadId: string, profile: AgentGatewayRoleProfile | null) => void;
  /** Whether a thread belongs to a Hub (coordinator, worker or member). */
  readonly isHubThread?: (threadId: ThreadId) => Effect.Effect<boolean>;
  readonly now?: () => string;
  readonly newThreadId?: () => ThreadId;
}

/** The provider command reactor, `wsRpc.ts`, the gateway and retention call these. */
export interface HelixCoordinatorHooks {
  /** A participant's role, from memory (no I/O). Null for every other thread. */
  readonly roleOf: (threadId: string) => RoleEntry | null;
  /** Every Builder thread id, for retention and sidebar hiding. */
  readonly builderThreadIds: () => ReadonlySet<string>;
  /** `ProviderSessionStartInput.helixRole` for a participant, else null. */
  readonly sessionRoleFor: (threadId: ThreadId) => Effect.Effect<ProviderHelixRoleContext | null>;
  /**
   * Called by the provider command reactor before it acts on a turn start.
   * Returns false when the turn is a Helix automatic turn that must not run
   * (held pair, cancelled epoch, superseded attempt); the suppression is
   * recorded here.
   */
  readonly admitAutomaticTurn: (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly dispatchOrigin?: string | undefined;
  }) => Effect.Effect<boolean>;
  /**
   * The same decision as `admitAutomaticTurn`, without recording anything. The
   * reactor asks it again immediately before the provider send and once the
   * turn id is bound, so a Stop that lands after admission still wins. Every
   * server turn on a participant goes through it: Helix briefs and wakes, and
   * any other server-originated turn (automations, goal continuation,
   * usage-limit recovery, quit-resume). Fails closed.
   */
  readonly shouldSendServerTurn: (input: {
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly dispatchOrigin?: string | undefined;
  }) => Effect.Effect<boolean>;
  /**
   * Called by `wsRpc.ts` for every client command before it is dispatched.
   * Fails only to refuse a command a participant must not take (decided from
   * memory and projections). Helix's own work for the command never blocks it:
   * a Stop is performed best-effort here, and `afterAccepted` (a user message
   * starting a goal) runs only once the engine accepted the command.
   */
  readonly interceptClientCommand: (
    command: OrchestrationCommand,
    options?: {
      /**
       * Whether the caller may change Helix (the owner, as for the helix.* RPCs).
       * False: a pairing on the message is not applied (`not_permitted`).
       */
      readonly mayConfigureHelix?: boolean;
    },
  ) => Effect.Effect<
    {
      readonly afterAccepted: Effect.Effect<void>;
      /** When the command carried a Helix pairing: what will happen (for `DispatchResult`). */
      readonly pairing?: HelixPairingOutcome;
      /** The command was not accepted: drop the planned pairing. */
      readonly cancel?: Effect.Effect<void>;
    },
    HelixServiceError
  >;
  /**
   * The reactor calls this before it acts on a user turn start: when that
   * message carried a pairing still being applied, wait for it (bounded) so
   * the turn's session starts with the right role.
   */
  readonly awaitMessagePairing: (threadId: ThreadId, messageId: string) => Effect.Effect<void>;
  /** `gitHandoffThread` and other workspace moves outside the command path. */
  /** `cwd`: the directory the operation acts on; refused when it is a pair's shared workspace. */
  readonly assertMayMoveWorkspace: (
    threadId: string,
    cwd?: string,
  ) => Effect.Effect<void, HelixServiceError>;
  /** Domain events from the engine (the reactor feeds every event). */
  readonly onDomainEvent: (event: OrchestrationEvent) => Effect.Effect<void>;
  /** Re-examine every pair with Builder work in flight. */
  readonly sweep: () => Effect.Effect<void>;
  /** Startup: reconcile unresolved handoffs and hold their pairs. Never replays. */
  readonly reconcileStartup: () => Effect.Effect<void>;
}

export interface HelixCoordinator {
  readonly service: HelixServiceShape;
  readonly port: HelixGatewayPortShape;
  readonly hooks: HelixCoordinatorHooks;
}

interface Waiter {
  readonly pairId: HelixPairId;
  readonly handoffId: HelixHandoffId;
  /** `fresh`: this waiter won the in-tool delivery compare-and-set. */
  readonly deferred: Deferred.Deferred<
    { readonly handoff: HelixHandoff; readonly fresh: boolean },
    HelixCoordinatorError
  >;
  claimed: boolean;
  done: boolean;
}

const BUILDER_SETTLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "thread.turn-diff-completed",
  "thread.session-set",
  "thread.turn-interrupt-requested",
  "thread.session-stop-requested",
  "thread.message-sent",
]);

const WORKSPACE_FIELDS = [
  "envMode",
  "branch",
  "worktreePath",
  "workingDirectory",
  "associatedWorktreePath",
  "associatedWorktreeBranch",
  "associatedWorktreeRef",
  "parentThreadId",
  "handoff",
] as const;

interface RoleEntry {
  readonly role: HelixRole;
  readonly pairId: HelixPairId;
  readonly active: boolean;
  /** The pair row does not decode: restricted, and no automatic turn may run. */
  readonly quarantined?: boolean;
  /** A former Builder whose pair is gone: no capabilities, no turns, for good. */
  readonly retired?: boolean;
  /** The other participant's thread. */
  readonly counterpartThreadId: string;
}

const RUNTIME_MODE_RANK: Readonly<Record<RuntimeMode, number>> = {
  "approval-required": 0,
  auto: 1,
  "full-access": 2,
};

/** The least permissive of the given modes (missing ones are ignored). */
export function strictestRuntimeMode(
  first: RuntimeMode,
  ...rest: ReadonlyArray<RuntimeMode | null | undefined>
): RuntimeMode {
  return rest.reduce<RuntimeMode>(
    (strictest, mode) =>
      mode != null && RUNTIME_MODE_RANK[mode] < RUNTIME_MODE_RANK[strictest] ? mode : strictest,
    first,
  );
}

/** Is a participant busy with a turn (running, starting, or with a live turn id)? */
function threadBusy(thread: OrchestrationThreadShell | null) {
  return (
    thread !== null &&
    (thread.latestTurn?.state === "running" ||
      thread.session?.activeTurnId != null ||
      thread.session?.status === "starting" ||
      thread.session?.status === "running")
  );
}

// ── Message pairing plans ───────────────────────────────────────────────

type PairingAction =
  | "none"
  | "enable"
  | "reenable"
  | "update"
  | "pend"
  | "disable"
  | "clear_pending";
interface PairingPlan {
  readonly outcome: HelixPairingOutcome;
  readonly action: PairingAction;
  readonly pair: HelixPair | null;
  readonly pending: HelixPendingChange | null;
}

function notApplied(
  reason: NonNullable<HelixPairingOutcome["reason"]>,
  message: string,
): PairingPlan {
  return {
    outcome: { status: "not_applied", reason, message },
    action: "none",
    pair: null,
    pending: null,
  };
}

function planOf(
  status: HelixPairingOutcome["status"],
  action: PairingAction,
  pair: HelixPair | null,
  pending: HelixPendingChange | null = null,
): PairingPlan {
  return { outcome: { status }, action, pair, pending };
}

function sameSelection(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeWorkspacePath(value: string) {
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

function workspaceDiffers(lead: OrchestrationThreadShell, builder: OrchestrationThreadShell) {
  return (
    lead.envMode !== builder.envMode ||
    lead.branch !== builder.branch ||
    lead.worktreePath !== builder.worktreePath ||
    (lead.workingDirectory ?? null) !== (builder.workingDirectory ?? null)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function threadIdOf(event: OrchestrationEvent): string | null {
  const payload = event.payload as { readonly threadId?: unknown };
  return typeof payload?.threadId === "string" ? payload.threadId : null;
}

/** A participant guard's refusal: `reason` travels as `WsRpcError.reason`. */
interface HelixRefusal {
  readonly reason: HelixRefusalReason;
  readonly message: string;
}

const BUILDER_READ_ONLY_MESSAGE =
  "This is a Helix Builder: it is driven by its Lead. Send your message to the Lead chat instead.";

// ── Factory ─────────────────────────────────────────────────────────────

export const makeHelixCoordinator = (deps: HelixCoordinatorDeps) =>
  Effect.gen(function* () {
    const { repository, runtime } = deps;
    const now = deps.now ?? (() => new Date().toISOString());
    const newThreadId = deps.newThreadId ?? (() => ThreadId.makeUnsafe(randomUUID()));
    const events = yield* PubSub.unbounded<HelixStreamEvent>();
    const locks = new Map<string, Semaphore.Semaphore>();
    const waiters = new Map<string, Set<Waiter>>();
    const roles = new Map<string, RoleEntry>();
    /** Startup reconciliation waits for the setting: with Helix off, boot does nothing else. */
    let reconcilePending = false;
    let rolesLoaded = false;
    const quarantinedPairs = new Set<string>();
    /**
     * Pairs the user stopped while Helix could not commit the Stop. Every Helix
     * turn of a fenced pair is refused until a durable stop commits (the sweep
     * and the next user message retry it).
     */
    const stopFences = new Set<string>();
    let fenceSerial = 0;
    /** Per pair (`<pairId>|<commandId>`): resends of a frozen command without a receipt. */
    const resendCounts = new Map<string, number>();
    /** Per pair (`<pairId>|<handoffId>`): Builder creation attempts with an unknown outcome. */
    const createAttempts = new Map<string, number>();
    /** Messages whose pairing is being applied; the reactor waits on these (bounded). */
    /** Pairings planned at intercept, applied once the message is accepted. */
    const plannedPairings = new Map<
      string,
      { readonly threadId: ThreadId; readonly pairing: HelixMessagePairing }
    >();
    /** Pairings being applied now: a second caller waits for the first. */
    const applyingPairings = new Map<string, Deferred.Deferred<void>>();
    /** Pairs with a pending change waiting for an idle boundary. */
    const pendingPairs = new Set<string>();
    /** Frozen creation payloads per attempt key, so a retry is the identical command. */
    const createPayloads = new Map<string, OrchestrationCommand>();
    /** The setting as last observed; role profiles follow it. */
    let settingOn = yield* deps.isEnabled;

    const withPairLock = <A, E, R>(pairId: string, effect: Effect.Effect<A, E, R>) => {
      let lock = locks.get(pairId);
      if (!lock) {
        lock = Effect.runSync(Semaphore.make(1));
        locks.set(pairId, lock);
      }
      return lock.withPermits(1)(effect);
    };

    const applyRoles = (pair: HelixPair) => {
      const active = pair.lifecycle === "active";
      roles.set(pair.leadThreadId, {
        role: "lead",
        pairId: pair.id,
        active,
        counterpartThreadId: pair.builderThreadId,
      });
      roles.set(pair.builderThreadId, {
        role: "builder",
        pairId: pair.id,
        active,
        counterpartThreadId: pair.leadThreadId,
      });
      // The Lead's tools exist only while its pair is active and the setting is on.
      deps.setRoleProfile?.(
        pair.leadThreadId,
        active && settingOn ? { kind: "helix_lead", pairId: pair.id } : null,
      );
      // A Builder credential stays restricted for as long as the pair row exists.
      deps.setRoleProfile?.(pair.builderThreadId, { kind: "helix_builder", pairId: pair.id });
    };

    /**
     * A former Builder never becomes an ordinary chat and its credentials never
     * widen: it keeps a capability-less profile for good (persisted by the
     * caller in `helix_retired_threads`, re-applied at boot).
     */
    const retireInMemory = (threadId: string, pairId: string) => {
      roles.set(threadId, {
        role: "builder",
        pairId: pairId as HelixPairId,
        active: false,
        retired: true,
        counterpartThreadId: "",
      });
      deps.setRoleProfile?.(threadId, { kind: "helix_retired", pairId });
    };

    /** The pair is gone: the Lead is an ordinary chat again, the Builder is retired. */
    const releaseRoles = (pairId: string, leadThreadId: string, builderThreadId: string) => {
      roles.delete(leadThreadId);
      deps.setRoleProfile?.(leadThreadId, null);
      retireInMemory(builderThreadId, pairId);
      locks.delete(pairId);
      for (const key of Array.from(resendCounts.keys())) {
        if (key.startsWith(`${pairId}|`)) resendCounts.delete(key);
      }
      for (const key of Array.from(createAttempts.keys())) {
        if (key.startsWith(`${pairId}|`)) createAttempts.delete(key);
      }
    };

    const quarantineReasons = new Map<string, string>();
    /**
     * Fail a pair closed without failing anything else: its Builder stays
     * restricted, its Lead loses the Lead tools, no Helix turn of it runs, and
     * the user can remove it (`removePair`).
     */
    const quarantine = (
      row: {
        readonly pairId: string;
        readonly leadThreadId: string;
        readonly builderThreadId: string;
      },
      reason: string,
    ) =>
      Effect.gen(function* () {
        const pairId = row.pairId as HelixPairId;
        const fresh = !quarantinedPairs.has(pairId);
        quarantinedPairs.add(pairId);
        quarantineReasons.set(pairId, reason);
        roles.set(row.leadThreadId, {
          role: "lead",
          pairId,
          active: true,
          quarantined: true,
          counterpartThreadId: row.builderThreadId,
        });
        roles.set(row.builderThreadId, {
          role: "builder",
          pairId,
          active: true,
          quarantined: true,
          counterpartThreadId: row.leadThreadId,
        });
        deps.setRoleProfile?.(row.leadThreadId, null);
        deps.setRoleProfile?.(row.builderThreadId, { kind: "helix_builder", pairId });
        if (fresh) {
          yield* Effect.logError("helix: a pair's data does not decode; it is quarantined", {
            pairId,
            reason,
          });
        }
      });

    /**
     * Restrict every stored participant. Never fails: pair data must not stop the
     * server from booting. An undecodable row is quarantined (its Builder stays
     * restricted, its automatic turns are refused); a failed read is retried by
     * the sweep.
     */
    const loadRoles = Effect.gen(function* () {
      const listed = yield* Effect.result(repository.listPairsTolerant());
      if (listed._tag === "Failure") {
        yield* Effect.logError(
          "helix: could not read pairs; Builder restrictions will be retried",
          {
            cause: listed.failure,
          },
        );
        return;
      }
      for (const pair of listed.success.pairs) {
        if (!quarantinedPairs.has(pair.id)) applyRoles(pair);
        if ((pair.config.pendingChange ?? null) !== null) pendingPairs.add(pair.id);
      }
      for (const row of listed.success.invalid) {
        yield* quarantine(row, "Its pair record could not be read.");
      }
      // Retried before giving up: until it is read, a retired Builder's id is not
      // restricted (the sweep keeps retrying every 2 s).
      const retired = yield* Effect.result(
        repository
          .listRetiredThreads()
          .pipe(Effect.retry({ times: 3, schedule: Schedule.spaced(Duration.millis(100)) })),
      );
      if (retired._tag === "Failure") {
        yield* Effect.logError("helix: could not read retired Builders; will retry", {
          cause: retired.failure,
        });
        return;
      }
      for (const row of retired.success) {
        if (!roles.has(row.threadId)) retireInMemory(row.threadId, row.pairId);
      }
      // Stops requested before a restart that never committed keep their fence.
      const requested = yield* Effect.result(repository.listStopRequests());
      if (requested._tag === "Success") {
        for (const pairId of requested.success) stopFences.add(pairId);
      }
      rolesLoaded = true;
    });
    yield* loadRoles;

    const publish = (event: HelixStreamEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);

    /**
     * The pair and every handoff that decodes. A handoff row that does not
     * decode quarantines the pair at runtime; the aggregate is still returned
     * (`corrupt`) so a Stop can always commit.
     */
    const loadAggregate = (pairId: HelixPairId) =>
      Effect.gen(function* () {
        const pair = yield* repository.getPair(pairId);
        if (pair === null) return yield* Effect.fail(refuse("not_found", "No such Helix pair."));
        const listed = yield* repository.listHandoffsTolerant(pairId);
        if (listed.invalid.length > 0) {
          yield* quarantine(
            { pairId, leadThreadId: pair.leadThreadId, builderThreadId: pair.builderThreadId },
            `${listed.invalid.length} of its handoff records could not be read.`,
          );
        }
        return {
          pair,
          handoffs: listed.handoffs,
          corrupt: listed.invalid.length > 0,
        } satisfies HelixAggregate & { readonly corrupt: boolean };
      }).pipe(Effect.mapError(storage("Could not load the Helix pair.")));

    const loadView = (pairId: HelixPairId) =>
      Effect.gen(function* () {
        const pair = yield* repository.getPair(pairId);
        if (pair === null) return yield* Effect.fail(refuse("not_found", "No such Helix pair."));
        const handoffs = yield* repository.listHandoffs(pairId, {
          limit: HELIX_PAIR_VIEW_MAX_HANDOFFS,
        });
        return helixPairView(pair, handoffs);
      }).pipe(Effect.mapError(storage("Could not load the Helix pair.")));

    interface Committed {
      readonly transition: HelixTransitionOk;
      readonly pair: HelixPair;
      readonly handoffs: ReadonlyArray<HelixHandoff>;
    }

    const commitUnderLock = (
      pairId: HelixPairId,
      build: (aggregate: HelixAggregate) => HelixCommand | HelixCoordinatorError,
    ) =>
      withPairLock(
        pairId,
        Effect.gen(function* () {
          for (let attempt = 0; ; attempt += 1) {
            const aggregate = yield* loadAggregate(pairId);
            const command = build(aggregate);
            if (command instanceof HelixCoordinatorError) return yield* Effect.fail(command);
            // A pair with unreadable handoffs takes only a Stop; remove it to go on.
            if (aggregate.corrupt && command.type !== "stop") {
              return yield* Effect.fail(
                refuse(
                  "storage",
                  "This Helix pair's data could not be read. Remove the pair from the Helix panel.",
                ),
              );
            }
            const transition = transitionHelix(aggregate, command);
            if (!transition.ok) return yield* Effect.fail(fromTransition(transition.error));
            if (!transition.changed) {
              return {
                transition,
                pair: aggregate.pair,
                handoffs: aggregate.handoffs,
              } satisfies Committed;
            }
            const committed = yield* repository
              .commit({
                pair: transition.pair,
                expectedRevision: transition.expectedRevision,
                handoffs: transition.writes,
              })
              .pipe(
                Effect.map((value) => ({ ok: true as const, value })),
                Effect.catchTag("HelixRepositoryError", (error: HelixRepositoryError) =>
                  error.code === "stale_revision" && attempt < 3
                    ? Effect.succeed({ ok: false as const })
                    : Effect.fail(storage(error.message)(error)),
                ),
              );
            if (!committed.ok) continue;
            const byId = new Map(aggregate.handoffs.map((handoff) => [handoff.id, handoff]));
            for (const handoff of committed.value.handoffs) byId.set(handoff.id, handoff);
            const handoffs = [...byId.values()];
            const pair = committed.value.pair;
            yield* publish({ type: "pair-upserted", summary: helixPairSummary(pair, handoffs) });
            for (const handoff of committed.value.handoffs) {
              yield* publish({ type: "handoff-upserted", handoff });
            }
            return { transition, pair, handoffs } satisfies Committed;
          }
        }),
      );

    interface EffectOptions {
      /** The participant thread the user's own Stop is already interrupting. */
      readonly alreadyInterrupting?: ThreadId;
      /** Restart reconciliation: finalise results but deliver nothing until the user resumes. */
      readonly suppressDelivery?: boolean;
    }

    /** Commit one command, then perform its effects outside the lock. */
    const mutate = (
      pairId: HelixPairId,
      build: (aggregate: HelixAggregate) => HelixCommand | HelixCoordinatorError,
      options?: EffectOptions,
    ): Effect.Effect<Committed, HelixCoordinatorError> =>
      commitUnderLock(pairId, build).pipe(
        // Effects run on a detached fiber: a caller interrupted mid-way (a Lead
        // tool call cancelled, a client gone during Stop) never strands them.
        Effect.tap((committed) =>
          runEffects(committed.pair, committed.transition.effects, options ?? {}).pipe(
            Effect.forkDetach,
            Effect.flatMap(Fiber.join),
          ),
        ),
      );

    const quietly = <A>(label: string, effect: Effect.Effect<A, unknown>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning(`helix: ${label} failed`, { cause: Cause.pretty(cause) }),
        ),
      ) as Effect.Effect<void>;

    // ── Effects ───────────────────────────────────────────────────────

    const runEffects = (
      pair: HelixPair,
      effects: ReadonlyArray<HelixEffect>,
      options: EffectOptions,
    ): Effect.Effect<void> =>
      Effect.forEach(effects, (effect) => quietly(effect.type, runEffect(pair, effect, options)), {
        discard: true,
      });

    const runEffect = (
      pair: HelixPair,
      effect: HelixEffect,
      options: EffectOptions,
    ): Effect.Effect<void, unknown> => {
      switch (effect.type) {
        case "dispatch_ready":
          return dispatchHandoff(pair.id, effect.handoffId, effect.needsBuilderThread);
        case "deliver_result":
          return options.suppressDelivery === true
            ? Effect.void
            : deliverResult(
                pair.id,
                effect.handoffId,
                effect.wakeAllowed,
                effect.afterResume === true,
              );
        case "interrupt_participants":
          return Effect.forEach(
            [effect.leadThreadId, effect.builderThreadId].filter(
              (threadId) => threadId !== options.alreadyInterrupting,
            ),
            (threadId) =>
              interruptThread(
                pair,
                threadId,
                threadId === effect.builderThreadId && effect.builderHadWork,
              ),
            { discard: true },
          );
        case "cancel_waits":
          return cancelWaits(pair.id);
        case "update_role_profiles":
          return Effect.sync(() => applyRoles(pair));
        case "archive_builder_thread":
          return archiveBuilder(pair, `${pair.id}:${pair.revision}`);
        case "unarchive_builder_thread":
          return unarchiveBuilder(pair, `${pair.id}:${pair.revision}`);
        case "restart_builder_session":
          return runtime.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(`helix:builder-model:${pair.id}:${pair.revision}`),
            threadId: pair.builderThreadId,
            modelSelection: pair.config.builderModelSelection,
          });
      }
    };

    /**
     * `force`: the Builder had a handoff in flight, so its turn may still be
     * starting with no visible turn id: interrupt it anyway (turnless).
     */
    const interruptThread = (pair: HelixPair, threadId: ThreadId, force = false) =>
      Effect.gen(function* () {
        const thread = yield* runtime.getThread(threadId);
        if (!thread) return;
        const activeTurnId = thread.session?.activeTurnId ?? null;
        const busy =
          activeTurnId !== null ||
          thread.latestTurn?.state === "running" ||
          thread.session?.status === "starting" ||
          thread.session?.status === "running";
        if (!busy && !force) return;
        yield* runtime.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.makeUnsafe(
            `helix:stop:${pair.id}:${pair.cancellationEpoch}:${threadId}`,
          ),
          threadId,
          ...(activeTurnId !== null ? { turnId: activeTurnId } : {}),
          requestedBy: "system",
          createdAt: now(),
        });
      });

    const archiveBuilder = (pair: HelixPair, key: string) =>
      Effect.gen(function* () {
        const builder = yield* runtime.getThread(pair.builderThreadId);
        if (!builder || builder.archivedAt != null) return;
        yield* runtime.dispatch({
          type: "thread.archive",
          commandId: CommandId.makeUnsafe(`helix:archive-builder:${key}`),
          threadId: pair.builderThreadId,
        });
      });

    const unarchiveBuilder = (pair: HelixPair, key: string) =>
      Effect.gen(function* () {
        const builder = yield* runtime.getThread(pair.builderThreadId);
        if (!builder || builder.archivedAt == null) return;
        yield* runtime.dispatch({
          type: "thread.unarchive",
          commandId: CommandId.makeUnsafe(`helix:unarchive-builder:${key}`),
          threadId: pair.builderThreadId,
        });
      });

    /** Create the Builder thread in the Lead's workspace (idempotent per attempt), then record it. */
    /** Builder creation attempts with an unknown engine outcome before the handoff is abandoned. */
    const HELIX_MAX_CREATE_ATTEMPTS = 5;
    const ensureBuilderThread = (pairId: HelixPairId, attemptKey: string) =>
      Effect.gen(function* () {
        const pair = yield* repository
          .getPair(pairId)
          .pipe(Effect.mapError(storage("Could not load the Helix pair.")));
        if (pair === null || pair.builderCreatedAt !== null) return;
        const existing = yield* runtime.getThread(pair.builderThreadId);
        if (existing === null) {
          const lead = yield* runtime.getThread(pair.leadThreadId);
          if (lead === null) return yield* Effect.fail(refuse("not_found", "The Lead is gone."));
          const frozenKey = `${pairId}|${attemptKey}`;
          const command =
            createPayloads.get(frozenKey) ?? builderCreateCommand(pair, lead, attemptKey);
          createPayloads.set(frozenKey, command);
          yield* runtime.dispatch(command);
          createPayloads.delete(frozenKey);
        }
        yield* mutate(pairId, () => ({ type: "builder.created", now: now() }));
      });

    const builderCreateCommand = (
      pair: HelixPair,
      lead: OrchestrationThreadShell,
      attemptKey: string,
    ): OrchestrationCommand => ({
      type: "thread.create",
      // Deterministic per attempt with a frozen timestamp: a retry of the same
      // attempt replays its receipt, and a refused attempt never blocks the next.
      commandId: CommandId.makeUnsafe(`helix:create-builder:${pair.id}:${attemptKey}`),
      threadId: pair.builderThreadId,
      projectId: lead.projectId,
      title: `Builder · ${lead.title}`.slice(0, 200),
      modelSelection: pair.config.builderModelSelection,
      // Never more permissive than the Lead is now.
      runtimeMode: strictestRuntimeMode(pair.config.builderRuntimeMode, lead.runtimeMode),
      interactionMode: "default",
      // The Lead's existing workspace: no new worktree, so no setup script runs.
      envMode: lead.envMode,
      branch: lead.branch,
      worktreePath: lead.worktreePath,
      workingDirectory: lead.workingDirectory,
      associatedWorktreePath: lead.associatedWorktreePath,
      associatedWorktreeBranch: lead.associatedWorktreeBranch,
      associatedWorktreeRef: lead.associatedWorktreeRef,
      createBranchFlowCompleted: lead.createBranchFlowCompleted,
      isPinned: false,
      // Linked only through the Helix tables, never as a native sub-agent.
      parentThreadId: null,
      subagentAgentId: null,
      subagentNickname: null,
      subagentRole: null,
      lastKnownPr: null,
      createdAt: pair.createdAt,
    });

    /** Persist the dispatch intent, then hand the brief to the engine. */
    const dispatchHandoff = (
      pairId: HelixPairId,
      handoffId: HelixHandoffId,
      needsBuilderThread: boolean,
    ) =>
      Effect.gen(function* () {
        if (needsBuilderThread) {
          const aggregate = yield* loadAggregate(pairId);
          const pending = aggregate.handoffs.find((entry) => entry.id === handoffId);
          const created = yield* Effect.result(
            ensureBuilderThread(pairId, `${handoffId}:${(pending?.dispatchAttempts ?? 0) + 1}`),
          );
          if (created._tag === "Failure") {
            // A refusal is final for this handoff; an unknown outcome is retried by
            // the sweep a bounded number of times, then abandoned visibly.
            const unknown =
              !(created.failure instanceof HelixRuntimeError) || !created.failure.rejected;
            const attemptsKey = `${pairId}|${handoffId}`;
            const attempts = (createAttempts.get(attemptsKey) ?? 0) + 1;
            createAttempts.set(attemptsKey, attempts);
            if (unknown && attempts < HELIX_MAX_CREATE_ATTEMPTS) {
              return yield* Effect.fail(created.failure);
            }
            yield* mutate(pairId, () => ({
              type: "dispatch.abandoned",
              handoffId,
              reason: unknown
                ? `The Builder thread could not be created after ${attempts} attempts: ${errorMessage(created.failure)}`
                : `The Builder thread could not be created: ${errorMessage(created.failure)}`,
              now: now(),
            }));
            return;
          }
        }
        const runtimeMode = yield* builderRuntimeModeFor(pairId);
        const started = yield* mutate(pairId, (aggregate) => {
          const handoff = aggregate.handoffs.find((entry) => entry.id === handoffId);
          const attempt = (handoff?.dispatchAttempts ?? 0) + 1;
          return {
            type: "dispatch.start",
            handoffId,
            messageId: helixBriefMessageId(handoffId, attempt),
            ...(runtimeMode === null ? {} : { runtimeMode }),
            now: now(),
          };
        });
        const handoff = started.transition.handoff;
        const intent = handoff?.dispatch;
        if (!handoff || !intent || handoff.state !== "dispatching") return;
        yield* sendBrief(started.pair, handoff);
      });

    /** The stricter of the pair's mode, the Lead's current mode and the Builder's own. */
    const builderRuntimeModeFor = (pairId: HelixPairId) =>
      Effect.gen(function* () {
        const pair = yield* repository.getPair(pairId).pipe(Effect.orElseSucceed(() => null));
        if (pair === null) return null;
        const lead = yield* runtime
          .getThread(pair.leadThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        const builder = yield* runtime
          .getThread(pair.builderThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        return strictestRuntimeMode(
          pair.config.builderRuntimeMode,
          lead?.runtimeMode,
          builder?.runtimeMode,
        );
      });

    const sendBrief = (pair: HelixPair, handoff: HelixHandoff) =>
      Effect.gen(function* () {
        const intent = handoff.dispatch!;
        const lead = yield* runtime.getThread(pair.leadThreadId);
        const builder = yield* runtime.getThread(pair.builderThreadId);
        // The Builder works where the Lead works now, not where it worked at creation.
        if (lead !== null && builder !== null && workspaceDiffers(lead, builder)) {
          const synced = yield* Effect.result(
            runtime.dispatch({
              type: "thread.meta.update",
              commandId: CommandId.makeUnsafe(`helix:sync-workspace:${intent.commandId}`),
              threadId: pair.builderThreadId,
              envMode: lead.envMode,
              branch: lead.branch,
              worktreePath: lead.worktreePath,
              workingDirectory: lead.workingDirectory,
            }),
          );
          if (synced._tag === "Failure" && synced.failure.rejected) {
            yield* mutate(pair.id, () => ({
              type: "dispatch.abandoned",
              handoffId: handoff.id,
              reason: `The Builder could not follow the Lead's workspace: ${synced.failure.message}`,
              now: now(),
            }));
            return;
          }
          if (synced._tag === "Failure") return yield* Effect.fail(synced.failure);
        }
        // Frozen at the first attempt (a resend is the identical command); older
        // intents fall back to the stricter of the pair's, the Lead's and the Builder's mode.
        const runtimeMode =
          intent.runtimeMode ??
          strictestRuntimeMode(
            pair.config.builderRuntimeMode,
            lead?.runtimeMode,
            builder?.runtimeMode,
          );
        const result = yield* Effect.result(
          runtime.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(intent.commandId),
            threadId: pair.builderThreadId,
            message: {
              messageId: intent.messageId,
              role: "user",
              text: renderHelixBrief(handoff),
              attachments: [],
            },
            // Explicit: a refused model fails this turn visibly instead of silently keeping the old one.
            modelSelection: pair.config.builderModelSelection,
            dispatchMode: "queue",
            dispatchOrigin: "agent",
            runtimeMode,
            interactionMode: "default",
            createdAt: intent.createdAt,
          }),
        );
        if (result._tag === "Success") {
          yield* mutate(pair.id, () => ({
            type: "dispatch.acknowledged",
            handoffId: handoff.id,
            commandId: intent.commandId,
            builderTurnId: null,
            now: now(),
          }));
          return;
        }
        // A storage failure says nothing about the engine; leave the intent for
        // restart reconciliation, which reads the command ledger.
        if (!result.failure.rejected) return yield* Effect.fail(result.failure);
        yield* mutate(pair.id, () => ({
          type: "dispatch.failed",
          handoffId: handoff.id,
          commandId: intent.commandId,
          reason: `The Builder could not start: ${result.failure.message}`,
          now: now(),
        }));
      });

    // ── Waiting and delivery ──────────────────────────────────────────

    const waitersFor = (handoffId: string) => {
      let set = waiters.get(handoffId);
      if (!set) {
        set = new Set();
        waiters.set(handoffId, set);
      }
      return set;
    };

    const removeWaiter = (waiter: Waiter) => {
      waiter.done = true;
      const set = waiters.get(waiter.handoffId);
      set?.delete(waiter);
      if (set?.size === 0) waiters.delete(waiter.handoffId);
    };

    const cancelWaits = (pairId: HelixPairId) =>
      Effect.gen(function* () {
        // Copies: removeWaiter mutates the collections being walked.
        for (const set of Array.from(waiters.values())) {
          for (const waiter of Array.from(set)) {
            if (waiter.pairId !== pairId || waiter.done) continue;
            removeWaiter(waiter);
            yield* Deferred.fail(
              waiter.deferred,
              new HelixCoordinatorError({
                reason: "transition",
                code: "pair_held",
                message:
                  "The user stopped Helix. Do not delegate again; tell the user where things stand.",
              }),
            );
          }
        }
      });

    /** Return a pending result to a waiting tool call (CAS), or wake the Lead. */
    const deliverResult = (
      pairId: HelixPairId,
      handoffId: HelixHandoffId,
      wakeAllowed: boolean,
      afterResume = false,
    ) =>
      Effect.gen(function* () {
        const waiting = [...(waiters.get(handoffId) ?? [])].filter(
          (waiter) => !waiter.done && !waiter.claimed,
        );
        if (waiting.length > 0) {
          for (const waiter of waiting) waiter.claimed = true;
          const returned = yield* Effect.result(
            mutate(pairId, () => ({ type: "result.returned", handoffId, now: now() })),
          );
          const handoff =
            returned._tag === "Success" && returned.success.transition.handoff
              ? returned.success.transition.handoff
              : yield* repository
                  .getHandoff(handoffId)
                  .pipe(Effect.mapError(storage("Could not load the handoff.")));
          // Only the compare-and-set winner may present the result as new.
          const fresh = returned._tag === "Success" && returned.success.transition.changed;
          for (const waiter of waiting) {
            removeWaiter(waiter);
            if (handoff) yield* Deferred.succeed(waiter.deferred, { handoff, fresh });
          }
          if (returned._tag === "Success") return;
        }
        if (wakeAllowed) yield* wakeLead(pairId, handoffId, afterResume);
      });

    const wakeLead = (pairId: HelixPairId, handoffId: HelixHandoffId, afterResume = false) =>
      Effect.gen(function* () {
        // With the setting off results are held (pending); the sweep delivers
        // them once it is back on.
        if (!(yield* deps.isEnabled)) return;
        const pairNow = yield* repository.getPair(pairId).pipe(Effect.orElseSucceed(() => null));
        const lead =
          pairNow === null
            ? null
            : yield* runtime.getThread(pairNow.leadThreadId).pipe(Effect.orElseSucceed(() => null));
        const requested = yield* Effect.result(
          mutate(pairId, (aggregate) => {
            const handoff = aggregate.handoffs.find((entry) => entry.id === handoffId);
            return {
              type: "wake.request",
              handoffId,
              messageId: helixWakeMessageId(handoffId, (handoff?.wakeAttempts ?? 0) + 1),
              runtimeMode: lead?.runtimeMode ?? "approval-required",
              interactionMode: lead?.interactionMode ?? "default",
              ...(afterResume ? { afterResume: true } : {}),
              now: now(),
            };
          }),
        );
        if (requested._tag === "Failure") return;
        const pair = requested.success.pair;
        const handoff = requested.success.transition.handoff;
        if (!handoff?.wake || handoff.delivery !== "wake_requested") return;
        yield* sendWake(pair, handoff);
      });

    const sendWake = (pair: HelixPair, handoff: HelixHandoff) =>
      Effect.gen(function* () {
        const wake = handoff.wake!;
        const lead = yield* runtime.getThread(pair.leadThreadId);
        const result = yield* Effect.result(
          runtime.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(wake.commandId),
            threadId: pair.leadThreadId,
            message: {
              messageId: wake.messageId,
              role: "user",
              // The result travels in the turn's own text: no completion outbox.
              text: renderHelixLeadWake(handoff),
              attachments: [],
            },
            dispatchMode: "queue",
            dispatchOrigin: "agent",
            runtimeMode: wake.runtimeMode ?? lead?.runtimeMode ?? "approval-required",
            interactionMode: wake.interactionMode ?? lead?.interactionMode ?? "default",
            createdAt: wake.createdAt,
          }),
        );
        if (result._tag === "Success") {
          yield* mutate(pair.id, () => ({
            type: "wake.dispatched",
            handoffId: handoff.id,
            commandId: wake.commandId,
            now: now(),
          }));
          return;
        }
        if (!result.failure.rejected) return yield* Effect.fail(result.failure);
        yield* mutate(pair.id, () => ({
          type: "wake.suppressed",
          handoffId: handoff.id,
          commandId: wake.commandId,
          now: now(),
        }));
      });

    /** Block a Lead tool call until the handoff has a result, up to `seconds`. */
    const awaitHandoff = (
      pairId: HelixPairId,
      handoffId: HelixHandoffId,
      seconds: number,
    ): Effect.Effect<
      { handoff: HelixHandoff; timedOut: boolean; fresh: boolean },
      HelixCoordinatorError
    > =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<
          { readonly handoff: HelixHandoff; readonly fresh: boolean },
          HelixCoordinatorError
        >();
        const waiter: Waiter = { pairId, handoffId, deferred, claimed: false, done: false };
        waitersFor(handoffId).add(waiter);
        // Re-check after registering: a result finalised in between is still caught.
        const current = yield* repository
          .getHandoff(handoffId)
          .pipe(Effect.mapError(storage("Could not load the handoff.")));
        if (current === null) {
          removeWaiter(waiter);
          return yield* Effect.fail(refuse("not_found", "No such handoff."));
        }
        if (current.delivery === "pending") {
          yield* quietly("in-tool delivery", deliverResult(pairId, handoffId, false));
        } else if (!isHelixHandoffActive(current.state)) {
          removeWaiter(waiter);
          return { handoff: current, timedOut: false, fresh: false };
        }
        if (waiter.done && !waiter.claimed) {
          return { handoff: current, timedOut: false, fresh: false };
        }
        const outcome = yield* Deferred.await(deferred).pipe(
          Effect.map(({ handoff, fresh }) => ({ handoff, timedOut: false, fresh })),
          Effect.timeoutOrElse({
            duration: Duration.seconds(seconds),
            onTimeout: () => {
              const timedOut = Effect.gen(function* () {
                removeWaiter(waiter);
                const latest = yield* repository
                  .getHandoff(handoffId)
                  .pipe(Effect.mapError(storage("Could not load the handoff.")));
                return {
                  handoff: latest ?? current,
                  timedOut: latest?.result == null,
                  fresh: false,
                };
              });
              // A delivery claimed this waiter just before the deadline: let it finish.
              return waiter.claimed
                ? Deferred.await(deferred).pipe(
                    Effect.map(({ handoff, fresh }) => ({ handoff, timedOut: false, fresh })),
                    Effect.timeoutOrElse({
                      duration: Duration.seconds(5),
                      onTimeout: () => timedOut,
                    }),
                  )
                : timedOut;
            },
          }),
          Effect.onInterrupt(() => Effect.sync(() => removeWaiter(waiter))),
        );
        return outcome;
      });

    // ── Builder observation ───────────────────────────────────────────

    /** Advance the pair's in-flight handoff from what the engine has recorded. */
    const checkBuilder = (pairId: HelixPairId, options: EffectOptions = {}) =>
      Effect.gen(function* () {
        const aggregate = yield* loadAggregate(pairId);
        const builderThreadId = aggregate.pair.builderThreadId;
        const inFlight = aggregate.handoffs.find(
          (handoff) => handoff.state === "dispatching" || handoff.state === "running",
        );
        const latest = aggregate.handoffs.reduce<HelixHandoff | null>(
          (best, handoff) => (best === null || handoff.sequence > best.sequence ? handoff : best),
          null,
        );
        // A handoff Stop closed may still settle later: keep that result inspectable.
        const closedLate =
          latest &&
          latest.dispatch !== null &&
          latest.result === null &&
          latest.lateResult === null &&
          (latest.state === "interrupted" ||
            latest.state === "cancelled" ||
            latest.state === "uncertain")
            ? latest
            : null;
        const target = inFlight ?? closedLate;
        if (!target?.dispatch) return;
        const intent = target.dispatch;
        const turn = yield* runtime.findTurnForMessage(builderThreadId, intent.messageId);
        if (turn === null || turn.state === "pending") {
          if (target !== inFlight) return;
          const failure = yield* runtime.initialFailure(builderThreadId, intent.messageId);
          if (failure !== null) {
            yield* mutate(
              pairId,
              () => ({
                type: "dispatch.failed",
                handoffId: target.id,
                commandId: intent.commandId,
                reason: failure.error ?? "The Builder's session failed before the turn started.",
                now: now(),
              }),
              options,
            );
            return;
          }
          const delivery = yield* runtime.deliveryState(builderThreadId, intent.messageId);
          if (delivery === "uncertain" || delivery === "dead") {
            // A refused send (e.g. an unusable model) carries the provider's reason.
            const lastError =
              (yield* runtime.getThread(builderThreadId))?.session?.lastError ?? null;
            yield* mutate(
              pairId,
              () => ({
                type: delivery === "uncertain" ? "dispatch.uncertain" : "dispatch.failed",
                handoffId: target.id,
                commandId: intent.commandId,
                reason:
                  delivery === "uncertain"
                    ? "The provider did not confirm the brief was received."
                    : `The Builder could not start the brief${lastError ? `: ${lastError}` : "."}`,
                now: now(),
              }),
              options,
            );
          }
          return;
        }
        if (target === inFlight && target.builderTurnId === null && turn.turnId !== null) {
          yield* mutate(
            pairId,
            () => ({
              type: "dispatch.acknowledged",
              handoffId: target.id,
              commandId: intent.commandId,
              builderTurnId: turn.turnId,
              now: now(),
            }),
            options,
          );
        }
        if (turn.state === "running") return;
        if (
          turn.state === "completed" &&
          turn.turnId !== null &&
          !(yield* runtime.hasCompletedRun(builderThreadId, turn.turnId))
        ) {
          return;
        }
        // The turn settled; its final output must be fully ingested first.
        if (!(yield* runtime.isOutputSettled(builderThreadId))) return;
        const finalMessage =
          turn.turnId === null
            ? null
            : yield* runtime.finalAssistantText(builderThreadId, turn.turnId);
        yield* mutate(
          pairId,
          () => ({
            type: "turn.settled",
            handoffId: target.id,
            builderTurnId: turn.turnId,
            turnOutcome:
              turn.state === "completed"
                ? "completed"
                : turn.state === "error"
                  ? "failed"
                  : "interrupted",
            finalMessage,
            now: now(),
          }),
          options,
        );
      });

    // ── Startup reconciliation ────────────────────────────────────────

    const reconcilePair = (pairId: HelixPairId) =>
      Effect.gen(function* () {
        // Results that already settled are finalised first; nothing is resent.
        yield* checkBuilder(pairId, { suppressDelivery: true }).pipe(Effect.ignore);
        const aggregate = yield* loadAggregate(pairId);
        const evidence = new Map<HelixHandoffId, HelixRestartEvidence>();
        for (const handoff of aggregate.handoffs) {
          if (handoff.state === "dispatching" && handoff.dispatch) {
            const accepted = yield* runtime.commandAccepted(handoff.dispatch.commandId);
            if (!accepted) {
              evidence.set(handoff.id, "not_sent");
              continue;
            }
            const turn = yield* runtime.findTurnForMessage(
              aggregate.pair.builderThreadId,
              handoff.dispatch.messageId,
            );
            const delivery = yield* runtime.deliveryState(
              aggregate.pair.builderThreadId,
              handoff.dispatch.messageId,
            );
            evidence.set(
              handoff.id,
              turn !== null && turn.state !== "pending" && delivery !== "uncertain"
                ? "turn_started"
                : "send_uncertain",
            );
          }
          if (handoff.delivery === "wake_requested" && handoff.wake) {
            const accepted = yield* runtime.commandAccepted(handoff.wake.commandId);
            yield* mutate(pairId, () => ({
              type: accepted ? "wake.dispatched" : "wake.suppressed",
              handoffId: handoff.id,
              commandId: handoff.wake!.commandId,
              now: now(),
            }));
          }
        }
        yield* mutate(pairId, () => ({ type: "restart.reconcile", evidence, now: now() }));
      });

    /** Pairs with unresolved work; a pair with an unreadable handoff row is quarantined. */
    const unresolvedPairIds = () =>
      Effect.gen(function* () {
        const listed = yield* repository
          .listUnresolvedHandoffsTolerant()
          .pipe(Effect.mapError(storage("Could not list unresolved Helix work.")));
        for (const pairId of listed.invalidPairIds) {
          if (quarantinedPairs.has(pairId)) continue;
          const pair = yield* repository
            .getPair(pairId as HelixPairId)
            .pipe(Effect.orElseSucceed(() => null));
          if (pair !== null) {
            yield* quarantine(
              { pairId, leadThreadId: pair.leadThreadId, builderThreadId: pair.builderThreadId },
              "One of its handoff records could not be read.",
            );
          }
        }
        return new Set(listed.handoffs.map((handoff) => handoff.pairId));
      });

    const reconcileStartup = () =>
      Effect.gen(function* () {
        const pairIds = yield* unresolvedPairIds();
        for (const pairId of pairIds) {
          if (quarantinedPairs.has(pairId)) continue;
          yield* quietly(`restart reconciliation of ${pairId}`, reconcilePair(pairId));
        }
      });

    // ── Stop and goals ────────────────────────────────────────────────

    const stopPairDurably = (pairId: HelixPairId, alreadyInterrupting?: ThreadId) =>
      mutate(
        pairId,
        () => ({ type: "stop", now: now() }),
        alreadyInterrupting === undefined ? {} : { alreadyInterrupting },
      ).pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            if (stopFences.delete(pairId)) {
              yield* quietly("stop request clear", repository.clearStopRequest(pairId));
            }
            // A quarantined pair may hide a running handoff: interrupt anyway.
            if (quarantinedPairs.has(pairId)) yield* fenceInterrupts(pairId, alreadyInterrupting);
          }),
        ),
      );

    /** Turnless interrupts of both participants, from memory (no pair read needed). */
    const fenceInterrupts = (pairId: string, alreadyInterrupting?: ThreadId) =>
      Effect.gen(function* () {
        fenceSerial += 1;
        const serial = fenceSerial;
        const participants = [...roles.entries()].filter(([, entry]) => entry.pairId === pairId);
        for (const [threadId] of participants) {
          if (threadId === alreadyInterrupting) continue;
          yield* quietly(
            "fenced interrupt",
            runtime.dispatch({
              type: "thread.turn.interrupt",
              commandId: CommandId.makeUnsafe(`helix:stop-fence:${pairId}:${serial}:${threadId}`),
              threadId: ThreadId.makeUnsafe(threadId),
              requestedBy: "system",
              createdAt: now(),
            }),
          );
        }
      });

    /**
     * Stop a pair. When the Stop cannot commit, Helix still interrupts both
     * participants and fences the pair (every Helix turn refused) until a
     * durable stop commits; the error is returned for callers that report it.
     */
    const stopPair = (pairId: HelixPairId, alreadyInterrupting?: ThreadId) =>
      stopPairDurably(pairId, alreadyInterrupting).pipe(
        Effect.tapCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.gen(function* () {
                stopFences.add(pairId);
                // Durable when storage allows: the fence then survives a restart.
                yield* quietly("stop request record", repository.recordStopRequest(pairId));
                yield* Effect.logError("helix: Stop did not commit; the pair is fenced", {
                  pairId,
                  cause: Cause.pretty(cause),
                });
                yield* fenceInterrupts(pairId, alreadyInterrupting);
              }),
        ),
      );

    const startGoal = (pairId: HelixPairId, messageId: MessageId) =>
      mutate(pairId, () => ({ type: "user_message", messageId, now: now() }));

    // ── Lifecycle following the Lead ──────────────────────────────────

    const onLeadArchived = (pairId: HelixPairId, sequence: number) =>
      Effect.gen(function* () {
        const pair = yield* repository
          .getPair(pairId)
          .pipe(Effect.mapError(storage("Could not load the Helix pair.")));
        if (pair === null) return;
        if (pair.lifecycle === "active") yield* stopPair(pairId);
        yield* archiveBuilder(pair, `${pair.id}:lead-archived:${sequence}`);
      });

    const onLeadUnarchived = (pairId: HelixPairId, sequence: number) =>
      Effect.gen(function* () {
        const pair = yield* repository
          .getPair(pairId)
          .pipe(Effect.mapError(storage("Could not load the Helix pair.")));
        if (pair === null || pair.lifecycle !== "active") return;
        yield* unarchiveBuilder(pair, `${pair.id}:lead-unarchived:${sequence}`);
      });

    const onLeadDeleted = (pairId: HelixPairId) =>
      Effect.gen(function* () {
        const pair = yield* repository
          .getPair(pairId)
          .pipe(Effect.mapError(storage("Could not load the Helix pair.")));
        if (pair === null) return;
        if (pair.lifecycle === "active")
          yield* stopPair(pairId, pair.leadThreadId).pipe(Effect.ignore);
        const builder = yield* runtime.getThread(pair.builderThreadId);
        if (builder !== null) {
          yield* runtime.dispatch({
            type: "thread.delete",
            commandId: CommandId.makeUnsafe(`helix:delete-builder:${pair.id}`),
            threadId: pair.builderThreadId,
          });
        }
        yield* cancelWaits(pair.id);
        yield* repository
          .deletePair(pair.id, { retireThreadIds: [pair.builderThreadId] })
          .pipe(Effect.mapError(storage("Could not delete the Helix pair.")));
        releaseRoles(pair.id, pair.leadThreadId, pair.builderThreadId);
        yield* publish({
          type: "pair-removed",
          pairId: pair.id,
          leadThreadId: pair.leadThreadId,
          builderThreadId: pair.builderThreadId,
        });
      });

    /** A fenced pair is stopped durably before a user message starts its next goal. */
    const startGoalAfterFence = (pairId: HelixPairId, messageId: MessageId) =>
      Effect.gen(function* () {
        if (stopFences.has(pairId)) yield* stopPairDurably(pairId);
        yield* startGoal(pairId, messageId);
      });

    /**
     * Remove a pair by id without decoding it: participants lose every role and
     * guard, the Builder is archived (or deleted with its Lead). The way out of
     * quarantine; also valid for a readable pair.
     */
    const removePairById = (pairId: string, options: { readonly deleteBuilder: boolean }) =>
      Effect.gen(function* () {
        const participants = [...roles.entries()].filter(
          ([, entry]) => entry.pairId === pairId && entry.retired !== true,
        );
        const lead = participants.find(([, entry]) => entry.role === "lead")?.[0];
        const builder = participants.find(([, entry]) => entry.role === "builder")?.[0];
        if (participants.length === 0) {
          return { pairId, removed: false } satisfies HelixRemovePairResult;
        }
        // A readable active pair is stopped durably first (epoch, hold, Builder
        // interrupt); if that fails the fence path still interrupts both.
        if (!quarantinedPairs.has(pairId) && roles.get(lead ?? "")?.active === true) {
          yield* stopPair(pairId as HelixPairId).pipe(Effect.ignore);
        }
        yield* fenceInterrupts(pairId);
        if (builder !== undefined) {
          const thread = yield* runtime
            .getThread(ThreadId.makeUnsafe(builder))
            .pipe(Effect.orElseSucceed(() => null));
          if (thread !== null && options.deleteBuilder) {
            yield* quietly(
              "builder removal",
              runtime.dispatch({
                type: "thread.delete",
                commandId: CommandId.makeUnsafe(`helix:delete-builder:${pairId}`),
                threadId: ThreadId.makeUnsafe(builder),
              }),
            );
          } else if (thread !== null && thread.archivedAt == null) {
            yield* quietly(
              "builder archive",
              runtime.dispatch({
                type: "thread.archive",
                commandId: CommandId.makeUnsafe(`helix:archive-builder:${pairId}:removed`),
                threadId: ThreadId.makeUnsafe(builder),
              }),
            );
          }
        }
        yield* cancelWaits(pairId as HelixPairId);
        yield* repository
          .deletePair(pairId as HelixPairId, {
            retireThreadIds: builder === undefined ? [] : [builder],
          })
          .pipe(Effect.mapError(storage("Could not remove the Helix pair.")));
        if (lead !== undefined) {
          roles.delete(lead);
          deps.setRoleProfile?.(lead, null);
        }
        if (builder !== undefined) releaseRoles(pairId, lead ?? "", builder);
        quarantinedPairs.delete(pairId);
        quarantineReasons.delete(pairId);
        stopFences.delete(pairId);
        if (lead !== undefined && builder !== undefined) {
          yield* publish({
            type: "pair-removed",
            pairId: pairId as HelixPairId,
            leadThreadId: ThreadId.makeUnsafe(lead),
            builderThreadId: ThreadId.makeUnsafe(builder),
          });
        }
        return { pairId, removed: true } satisfies HelixRemovePairResult;
      });

    /** The user deleted a disabled pair's Builder: the pair gets a fresh one, lazily. */
    const onBuilderDeleted = (pairId: HelixPairId, builderThreadId: ThreadId) =>
      Effect.gen(function* () {
        const pair = yield* repository
          .getPair(pairId)
          .pipe(Effect.mapError(storage("Could not load the Helix pair.")));
        if (pair === null || pair.builderThreadId !== builderThreadId) return;
        if (pair.lifecycle === "active") return;
        // Retired durably before the pair forgets it: its session may still be stopping.
        yield* repository
          .retireThread(builderThreadId, pairId)
          .pipe(Effect.mapError(storage("Could not retire the Builder.")));
        retireInMemory(builderThreadId, pairId);
        yield* mutate(pairId, () => ({
          type: "builder.replaced",
          builderThreadId: newThreadId(),
          now: now(),
        }));
      });

    /** Pin the role text actually delivered (always the current one) on idle pairs. */
    const upgradeRolePrompts = () =>
      Effect.gen(function* () {
        const listed = yield* repository.listPairsTolerant();
        for (const pair of listed.pairs) {
          if (quarantinedPairs.has(pair.id)) continue;
          const versions = pair.config.rolePromptVersions;
          if (
            versions.lead === HELIX_ROLE_PROMPT_VERSION &&
            versions.builder === HELIX_ROLE_PROMPT_VERSION
          ) {
            continue;
          }
          const [latest] = yield* repository.listHandoffs(pair.id, { limit: 1 });
          if (
            latest !== undefined &&
            (isHelixHandoffActive(latest.state) || latest.state === "awaiting_review")
          ) {
            continue;
          }
          yield* quietly(
            "role text upgrade",
            mutate(pair.id, (aggregate) => ({
              type: "config.update",
              expectedRevision: aggregate.pair.revision,
              rolePromptVersions: {
                lead: HELIX_ROLE_PROMPT_VERSION,
                builder: HELIX_ROLE_PROMPT_VERSION,
              },
              now: now(),
            })),
          );
        }
      });

    // ── Pairing carried by a user message ─────────────────────────────

    /** Busy for a configuration change: a handoff in flight or awaiting review. */
    const pairBusy = (pairId: HelixPairId) =>
      repository
        .listHandoffs(pairId, { limit: 1 })
        .pipe(
          Effect.map(
            ([latest]) =>
              latest !== undefined &&
              (isHelixHandoffActive(latest.state) || latest.state === "awaiting_review"),
          ),
        );

    /** What a message's pairing will do, without changing anything. Never fails. */
    const planPairing = (
      threadId: ThreadId,
      pairing: HelixMessagePairing,
    ): Effect.Effect<PairingPlan> =>
      Effect.gen(function* () {
        if (!(yield* deps.isEnabled)) {
          return notApplied(
            "setting_off",
            "Helix is off in Settings; the message was sent without it.",
          );
        }
        if (deps.setRoleProfile === undefined) {
          return notApplied("unavailable", "Helix cannot restrict a Builder on this server.");
        }
        const entry = roles.get(threadId);
        if (entry?.role === "builder") {
          return notApplied("builder_thread", "A Helix Builder cannot lead a pair.");
        }
        if (entry?.quarantined) {
          return notApplied(
            "quarantined",
            "This chat's Helix pair could not be read. Remove it from the Helix panel first.",
          );
        }
        const pair = yield* repository.getPairByLeadThread(threadId);
        if (!pairing.enabled) {
          if (pair === null || pair.lifecycle !== "active") {
            return planOf("unchanged", "none", pair);
          }
          return (yield* pairBusy(pair.id))
            ? planOf("pending", "pend", pair, { kind: "disable" })
            : planOf("applied", "disable", pair);
        }
        const builderSupport = helixRoleSupport(pairing.builderModelSelection.provider, "builder");
        if (!builderSupport.supported) {
          return notApplied("unsupported_builder_provider", builderSupport.reason);
        }
        if (pair !== null && pair.lifecycle === "active") {
          const pending = pair.config.pendingChange ?? null;
          if (sameSelection(pair.config.builderModelSelection, pairing.builderModelSelection)) {
            return pending === null
              ? planOf("unchanged", "none", pair)
              : planOf("applied", "clear_pending", pair);
          }
          const change: HelixPendingChange = {
            kind: "builder",
            builderModelSelection: pairing.builderModelSelection,
          };
          return (yield* pairBusy(pair.id))
            ? planOf("pending", "pend", pair, change)
            : planOf("applied", "update", pair);
        }
        const lead = yield* runtime.getThread(threadId);
        if (lead === null || lead.archivedAt != null) {
          return notApplied("unsupported_thread", "That chat does not exist or is archived.");
        }
        if (
          lead.parentThreadId != null ||
          lead.sidechatSourceThreadId != null ||
          lead.sidechatContext != null ||
          (deps.isHubThread !== undefined && (yield* deps.isHubThread(lead.id)))
        ) {
          return notApplied(
            "unsupported_thread",
            "Helix works only in an ordinary chat: not a sub-agent, side chat or Hub thread.",
          );
        }
        const leadSupport = helixRoleSupport(lead.modelSelection.provider, "lead");
        if (!leadSupport.supported) {
          return notApplied("unsupported_lead_provider", leadSupport.reason);
        }
        return planOf("applied", pair === null ? "enable" : "reenable", pair);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("helix: could not plan a message pairing", {
            threadId,
            cause: Cause.pretty(cause),
          }).pipe(
            Effect.as(
              notApplied("unavailable", "Helix could not read this chat's pair; sent without it."),
            ),
          ),
        ),
      );

    /** Apply a message's pairing once (idempotent per message), after the message was accepted. */
    const applyPairing = (threadId: ThreadId, pairing: HelixMessagePairing, messageId: string) =>
      Effect.gen(function* () {
        // Durable exactly-once: a retried message (even after a restart) claims nothing.
        if (!(yield* repository.claimMessageEffect(messageId, "pairing"))) return;
        const plan = yield* planPairing(threadId, pairing);
        const pair = plan.pair;
        switch (plan.action) {
          case "none":
            return;
          case "enable":
          case "reenable":
            if (pairing.enabled) {
              const enabled = yield* Effect.result(
                service.enable({
                  leadThreadId: threadId,
                  builderModelSelection: pairing.builderModelSelection,
                  ...(plan.action === "reenable" && pair !== null
                    ? { expectedRevision: pair.revision }
                    : {}),
                }),
              );
              if (enabled._tag === "Failure") {
                yield* surfacePairingFailure(
                  threadId,
                  `Helix could not be turned on: ${enabled.failure.message}`,
                );
              }
            }
            return;
          case "update":
            if (pairing.enabled && pair !== null) {
              const updated = yield* Effect.result(
                service.updateConfig({
                  pairId: pair.id,
                  expectedRevision: pair.revision,
                  builderModelSelection: pairing.builderModelSelection,
                }),
              );
              // Busy in between: keep it pending instead of losing it.
              if (updated._tag === "Failure") {
                yield* pendOrSurface(threadId, pair.id, {
                  kind: "builder",
                  builderModelSelection: pairing.builderModelSelection,
                });
              }
            }
            return;
          case "disable":
            if (pair !== null) {
              const disabled = yield* Effect.result(
                service.disable({ pairId: pair.id, expectedRevision: pair.revision }),
              );
              if (disabled._tag === "Failure") {
                yield* pendOrSurface(threadId, pair.id, { kind: "disable" });
              }
            }
            return;
          case "pend":
            if (pair !== null) yield* pendOrSurface(threadId, pair.id, plan.pending);
            return;
          case "clear_pending":
            if (pair !== null) yield* setPending(pair.id, null);
            return;
        }
      });

    /** Keep a change durable as pending; if even that fails, tell the user in the chat. */
    const pendOrSurface = (
      threadId: ThreadId,
      pairId: HelixPairId,
      change: HelixPendingChange | null,
    ) =>
      setPending(pairId, change).pipe(
        Effect.catch((error) =>
          surfacePairingFailure(
            threadId,
            `Helix could not record your change: ${errorMessage(error)}`,
          ),
        ),
        Effect.asVoid,
      );

    /** A pairing the client was told would apply did not: say so in the Lead's chat. */
    const surfacePairingFailure = (threadId: ThreadId, message: string) =>
      quietly(
        "pairing failure notice",
        runtime.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`helix:pairing-failed:${randomUUID()}`),
          threadId,
          activity: {
            id: EventId.makeUnsafe(randomUUID()),
            tone: "error",
            kind: "helix.pairing.failed",
            summary: "Helix change not applied",
            payload: { detail: message },
            turnId: null,
            createdAt: now(),
          },
          createdAt: now(),
        } as OrchestrationCommand),
      );

    const setPending = (pairId: HelixPairId, change: HelixPendingChange | null) =>
      mutate(pairId, () => ({ type: "config.pending", change, now: now() })).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (change === null) pendingPairs.delete(pairId);
            else pendingPairs.add(pairId);
          }),
        ),
      );

    /** Apply a pending change once the pair is idle (and before a new delegation). */
    const applyPendingIfIdle = (pairId: HelixPairId) =>
      Effect.gen(function* () {
        const pair = yield* repository.getPair(pairId);
        const change = pair?.config.pendingChange ?? null;
        if (pair === null || change === null || pair.lifecycle !== "active") {
          pendingPairs.delete(pairId);
          return;
        }
        if (yield* pairBusy(pairId)) return;
        if (change.kind === "disable") {
          yield* service.disable({ pairId, expectedRevision: pair.revision });
        } else {
          yield* service.updateConfig({
            pairId,
            expectedRevision: pair.revision,
            builderModelSelection: change.builderModelSelection,
          });
        }
        pendingPairs.delete(pairId);
      });

    /** A user message to an active Lead starts a goal (after any pairing it carried). */
    const goalStartFor = (threadId: string, messageId: string) =>
      Effect.suspend(() => {
        const entry = roles.get(threadId);
        if (!entry?.active || entry.role !== "lead" || entry.quarantined) return Effect.void;
        return quietly(
          "goal start",
          Effect.gen(function* () {
            // A retried message never starts a second goal, also after a restart.
            if (!(yield* repository.claimMessageEffect(messageId, "goal"))) return;
            yield* startGoalAfterFence(entry.pairId, MessageId.makeUnsafe(messageId));
          }),
        );
      });

    /**
     * Apply a message's planned pairing exactly once; concurrent callers (the
     * RPC's afterAccepted and the reactor's turn start) wait for the first.
     * Uninterruptible: a disconnect cannot leave it half done.
     */
    const applyPlannedPairing = (messageId: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const running = applyingPairings.get(messageId);
        if (running !== undefined) return Deferred.await(running);
        const planned = plannedPairings.get(messageId);
        if (planned === undefined) return Effect.void;
        plannedPairings.delete(messageId);
        // Registered synchronously, before any other fiber can look.
        const done = Effect.runSync(Deferred.make<void>());
        applyingPairings.set(messageId, done);
        return quietly(
          "message pairing",
          applyPairing(planned.threadId, planned.pairing, messageId),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => applyingPairings.delete(messageId)).pipe(
              Effect.andThen(Deferred.succeed(done, undefined)),
            ),
          ),
          Effect.uninterruptible,
        );
      });

    /** Once the engine accepted the message, its Helix effects run detached from the caller. */
    const afterAcceptedDetached = (effect: Effect.Effect<void>) =>
      effect.pipe(
        Effect.uninterruptible,
        Effect.forkDetach,
        Effect.flatMap(Fiber.join),
        Effect.ignore,
      );

    // ── Gating, guards and the sweep ──────────────────────────────────

    type ServerTurnDecision = {
      readonly admit: boolean;
      readonly stale: {
        readonly pairId: HelixPairId;
        readonly handoffId: HelixHandoffId;
        readonly kind: "dispatch" | "wake";
        readonly commandId: string;
      } | null;
    };
    const ADMIT: ServerTurnDecision = { admit: true, stale: null };
    const REFUSE: ServerTurnDecision = { admit: false, stale: null };

    /** Whether a server-originated turn may run now. No side effects; errors propagate. */
    const serverTurnDecision = (input: {
      readonly threadId: ThreadId;
      readonly messageId: string;
      readonly dispatchOrigin?: string | undefined;
    }): Effect.Effect<ServerTurnDecision, unknown> =>
      Effect.gen(function* () {
        const entry = roles.get(input.threadId);
        const parsed = parseHelixMessageId(input.messageId);
        if (!entry && parsed === null) return ADMIT;
        if (parsed !== null) {
          const handoff = yield* repository.getHandoff(parsed.handoffId as HelixHandoffId);
          if (handoff === null) return REFUSE;
          const pair = yield* repository.getPair(handoff.pairId);
          if (pair === null) return REFUSE;
          const intent = parsed.kind === "dispatch" ? handoff.dispatch : handoff.wake;
          const target = parsed.kind === "dispatch" ? pair.builderThreadId : pair.leadThreadId;
          const current =
            intent !== null &&
            intent.messageId === input.messageId &&
            target === input.threadId &&
            (parsed.kind === "dispatch"
              ? handoff.state === "dispatching" || handoff.state === "running"
              : (handoff.delivery === "wake_requested" || handoff.delivery === "wake_dispatched") &&
                // A wake for a handoff the Lead already reviewed has nothing to say.
                handoff.review === null);
          // Stop (epoch), disable, quarantine and a stop fence end Helix work.
          const live =
            current &&
            !quarantinedPairs.has(pair.id) &&
            !stopFences.has(pair.id) &&
            pair.lifecycle === "active" &&
            pair.hold?.kind !== "stop" &&
            handoff.epoch === pair.cancellationEpoch;
          // A brief already dispatched keeps running under Pause, a limit, a
          // restart hold or the setting turned off: those stop NEW work only. A
          // wake is new work for the Lead, so it waits for no hold and the setting.
          const admit =
            parsed.kind === "dispatch"
              ? live
              : live && pair.hold === null && (yield* deps.isEnabled);
          if (admit) return ADMIT;
          return {
            admit: false,
            stale:
              intent !== null && intent.messageId === input.messageId
                ? {
                    pairId: pair.id,
                    handoffId: handoff.id,
                    kind: parsed.kind,
                    commandId: intent.commandId,
                  }
                : null,
          };
        }
        // Any other turn on a participant. A Lead is an ordinary chat for non-Helix
        // turns (automations, goals, Hub, kanban): a Helix hold is about Helix work,
        // and helix_delegate is refused under it anyway.
        if (entry!.role === "lead") return ADMIT;
        // A Builder runs only Helix briefs: never a user turn (it is never an
        // ordinary chat while its pair exists) nor any other server turn.
        return REFUSE;
      });

    /** Why a client command must be refused for a participant, or null. Fails closed for reverts. */
    const clientCommandRefusal = (
      command: OrchestrationCommand,
    ): Effect.Effect<HelixRefusal | null> =>
      Effect.gen(function* () {
        if (command.type === "thread.handoff.create") {
          if (roles.get(command.sourceThreadId)?.active) {
            return {
              reason: "pair_active",
              message: "This chat is in a Helix pair: turn Helix off before handing it off.",
            };
          }
        }
        const threadId = "threadId" in command ? (command.threadId as string) : null;
        if (threadId === null) return null;
        const entry = roles.get(threadId);
        if (!entry) return null;
        const record = command as Record<string, unknown>;
        const touchedWorkspace = WORKSPACE_FIELDS.filter((field) => record[field] !== undefined);
        const requestedProvider = (record.modelSelection as { provider?: ProviderKind } | undefined)
          ?.provider;
        if (entry.retired) {
          // Readable and deletable; never runnable or brought back into use.
          return command.type === "thread.delete" || command.type === "thread.archive"
            ? null
            : {
                reason: "builder_read_only",
                message:
                  "This chat was a Helix Builder. It stays read-only; delete it if you no longer need it.",
              };
        }
        if (entry.role === "builder") {
          // Disabled or quarantined: the user may delete the Builder; the pair then
          // gets a fresh one (or, quarantined, is removed).
          const removable = !entry.active || entry.quarantined === true;
          switch (command.type) {
            case "thread.turn.start":
            case "thread.message.edit-and-resend":
              return { reason: "builder_read_only", message: BUILDER_READ_ONLY_MESSAGE };
            case "thread.delete":
              return removable
                ? null
                : {
                    reason: "builder_follows_lead",
                    message:
                      "A Helix Builder follows its Lead: turn Helix off first, or delete the Lead chat.",
                  };
            case "thread.archive":
            case "thread.unarchive":
              return {
                reason: "builder_follows_lead",
                message:
                  "A Helix Builder follows its Lead: archive or unarchive the Lead chat instead.",
              };
            case "thread.meta.update":
              if (touchedWorkspace.length > 0) {
                return {
                  reason: "builder_workspace_fixed",
                  message: `A Helix Builder shares its Lead's workspace; ${touchedWorkspace.join(", ")} cannot change.`,
                };
              }
              if (record.modelSelection !== undefined) {
                return {
                  reason: "builder_model_in_settings",
                  message: "Change the Builder's model in the chat's Helix settings.",
                };
              }
              return null;
            case "thread.checkpoint.revert":
              return entry.active ? yield* revertRefusal(entry.pairId, threadId) : null;
            default:
              return null;
          }
        }
        if (!entry.active) return null;
        // With the setting off a pair runs no new work: the Lead is guarded only
        // while its Builder may still be working in the shared workspace.
        if (!settingOn && !entry.quarantined) {
          const builder = yield* Effect.result(
            runtime.getThread(ThreadId.makeUnsafe(entry.counterpartThreadId)),
          );
          // Fails closed: an unreadable Builder counts as busy.
          const builderBusy = builder._tag === "Failure" || threadBusy(builder.success);
          if (!builderBusy && command.type !== "thread.checkpoint.revert") return null;
        }
        switch (command.type) {
          case "thread.meta.update":
            if (touchedWorkspace.length > 0) {
              return {
                reason: "lead_workspace_locked",
                message: `This chat is in a Helix pair with a Builder in the same workspace; ${touchedWorkspace.join(", ")} cannot change while Helix is on.`,
              };
            }
            break;
          case "thread.checkpoint.revert":
            return yield* revertRefusal(entry.pairId, threadId);
          default:
            break;
        }
        if (requestedProvider !== undefined) {
          const support = helixRoleSupport(requestedProvider, "lead");
          if (!support.supported)
            return { reason: "lead_provider_unsupported", message: support.reason };
        }
        return null;
      });

    /** A revert restores the whole shared worktree: only when neither side is working. */
    const revertRefusal = (pairId: HelixPairId, threadId: string) =>
      Effect.gen(function* () {
        const aggregate = yield* loadAggregate(pairId);
        if (
          aggregate.handoffs.some(
            (handoff) => isHelixHandoffActive(handoff.state) && handoff.state !== "prepared",
          )
        ) {
          return {
            reason: "revert_builder_busy",
            message: "The Builder is working in this workspace. Stop Helix before reverting.",
          } satisfies HelixRefusal;
        }
        const otherIsBuilder = threadId === aggregate.pair.leadThreadId;
        const other = otherIsBuilder ? aggregate.pair.builderThreadId : aggregate.pair.leadThreadId;
        if (threadBusy(yield* runtime.getThread(other))) {
          return otherIsBuilder
            ? ({
                reason: "revert_builder_busy",
                message: "The Builder is working in this workspace. Stop it before reverting.",
              } satisfies HelixRefusal)
            : ({
                reason: "revert_lead_busy",
                message: "The Lead is working in this workspace. Stop it before reverting.",
              } satisfies HelixRefusal);
        }
        return null;
      }).pipe(
        Effect.catchCause(() =>
          Effect.succeed({
            reason: "revert_unknown",
            message: "Helix could not confirm the shared workspace is idle; try again.",
          } satisfies HelixRefusal),
        ),
      );

    const SEND_GRACE_MS = 15_000;
    /** Resends of one frozen command without an engine receipt before giving up. */
    const HELIX_MAX_RESENDS = 5;
    const olderThan = (createdAt: string, ms: number) =>
      Date.parse(now()) - Date.parse(createdAt) > ms;

    /** Bring every non-terminal handoff of a pair forward, or hold or fail it visibly. */
    const sweepPair = (pairId: HelixPairId) =>
      Effect.gen(function* () {
        const aggregate = yield* loadAggregate(pairId);
        const pair = aggregate.pair;
        if (pair.lifecycle !== "active") return;
        for (const handoff of aggregate.handoffs) {
          if (handoff.epoch !== pair.cancellationEpoch) continue;
          if (handoff.state === "prepared" && pair.hold === null) {
            // A dispatch effect that failed (or never ran) is retried; a refusal fails it.
            yield* quietly(
              "prepared dispatch",
              dispatchHandoff(pairId, handoff.id, pair.builderCreatedAt === null),
            );
          } else if (
            handoff.state === "dispatching" &&
            handoff.dispatch !== null &&
            olderThan(handoff.dispatch.createdAt, SEND_GRACE_MS) &&
            !(yield* runtime.commandAccepted(handoff.dispatch.commandId))
          ) {
            // The engine never received the frozen intent: hand it the same command,
            // a bounded number of times; then the send is uncertain (held, never resent).
            const resendKey = `${pairId}|${handoff.dispatch.commandId}`;
            const resends = (resendCounts.get(resendKey) ?? 0) + 1;
            resendCounts.set(resendKey, resends);
            if (resends > HELIX_MAX_RESENDS) {
              const commandId = handoff.dispatch.commandId;
              yield* quietly(
                "brief resend cap",
                mutate(pairId, () => ({
                  type: "dispatch.uncertain",
                  handoffId: handoff.id,
                  commandId,
                  reason: `The engine never confirmed the brief after ${HELIX_MAX_RESENDS} attempts.`,
                  now: now(),
                })),
              );
            } else {
              yield* quietly("brief resend", sendBrief(pair, handoff));
            }
          } else if (
            handoff.delivery === "wake_requested" &&
            handoff.wake !== null &&
            olderThan(handoff.wake.createdAt, SEND_GRACE_MS) &&
            !(yield* runtime.commandAccepted(handoff.wake.commandId))
          ) {
            const resendKey = `${pairId}|${handoff.wake.commandId}`;
            const resends = (resendCounts.get(resendKey) ?? 0) + 1;
            resendCounts.set(resendKey, resends);
            if (resends > HELIX_MAX_RESENDS) {
              // Dropped: back to pending, and the next attempt counts toward the wake cap.
              const commandId = handoff.wake.commandId;
              yield* quietly(
                "wake resend cap",
                mutate(pairId, () => ({
                  type: "wake.suppressed",
                  handoffId: handoff.id,
                  commandId,
                  now: now(),
                })),
              );
            } else {
              yield* quietly("wake resend", sendWake(pair, handoff));
            }
          } else if (handoff.delivery === "pending" && pair.hold === null) {
            yield* quietly("delivery retry", deliverResult(pairId, handoff.id, true));
          }
        }
        if (aggregate.handoffs.some((handoff) => isHelixHandoffActive(handoff.state))) {
          yield* checkBuilder(pairId);
        }
      });

    // ── Hooks ─────────────────────────────────────────────────────────

    const hooks: HelixCoordinatorHooks = {
      roleOf: (threadId) => roles.get(threadId) ?? null,
      builderThreadIds: () =>
        new Set(
          [...roles.entries()]
            .filter(([, entry]) => entry.role === "builder")
            .map(([threadId]) => threadId),
        ),
      // From memory only, so it cannot fail for a participant: "not in a pair"
      // (null) is never confused with "could not determine". A Builder keeps its
      // role even in a quarantined pair; only a disabled pair launches without one.
      sessionRoleFor: (threadId) =>
        Effect.gen(function* () {
          const entry = roles.get(threadId);
          if (!entry) return null;
          // A Builder is a Builder for as long as its pair row exists (active,
          // disabled or quarantined): the same answer as its gateway credential.
          if (entry.role === "lead") {
            if (!entry.active || entry.quarantined || !(yield* deps.isEnabled)) return null;
            return {
              role: "lead",
              pairId: entry.pairId,
              promptVersion: HELIX_ROLE_PROMPT_VERSION,
              instructions: renderHelixRoleInstructions("lead", {
                builderThreadId: entry.counterpartThreadId,
              }),
            } satisfies ProviderHelixRoleContext;
          }
          return {
            role: "builder",
            pairId: entry.pairId,
            promptVersion: HELIX_ROLE_PROMPT_VERSION,
            instructions: renderHelixRoleInstructions("builder"),
          } satisfies ProviderHelixRoleContext;
        }),
      admitAutomaticTurn: (input) =>
        Effect.gen(function* () {
          const decision = yield* serverTurnDecision(input);
          if (decision.admit) return true;
          const stale = decision.stale;
          if (stale !== null) {
            yield* quietly(
              "suppression record",
              mutate(stale.pairId, () => ({
                type: stale.kind === "dispatch" ? "dispatch.suppressed" : "wake.suppressed",
                handoffId: stale.handoffId,
                commandId: stale.commandId,
                now: now(),
              })),
            );
          }
          return false;
        }).pipe(
          // Fail closed: if Helix cannot tell, the automatic turn does not run.
          Effect.catchCause((cause) =>
            Effect.logWarning("helix: automatic turn check failed; suppressing", {
              threadId: input.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
          ),
        ),
      shouldSendServerTurn: (input) =>
        serverTurnDecision(input).pipe(
          Effect.map((decision) => decision.admit),
          Effect.catchCause((cause) =>
            Effect.logWarning("helix: send check failed; refusing the automatic turn", {
              threadId: input.threadId,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
          ),
        ),
      interceptClientCommand: (command, options) =>
        Effect.gen(function* () {
          const none = { afterAccepted: Effect.void };
          const refusal = yield* clientCommandRefusal(command);
          if (refusal !== null) {
            return yield* Effect.fail(
              HelixServiceError.of(
                HELIX_RPC_ERROR_CODES.unsupportedThread,
                refusal.message,
                undefined,
                refusal.reason,
              ),
            );
          }
          const threadId = "threadId" in command ? (command.threadId as string) : null;
          if (threadId === null) return none;
          // A Helix pairing riding on a user message: planned now (the client is
          // told the outcome), applied only once the engine accepted the message,
          // and always before that message's turn starts (the reactor waits).
          const pairing =
            (command.type === "thread.turn.start" ||
              command.type === "thread.message.edit-and-resend") &&
            command.helix !== undefined
              ? {
                  value: command.helix,
                  messageId:
                    command.type === "thread.turn.start"
                      ? command.message.messageId
                      : command.messageId,
                }
              : null;
          if (pairing !== null) {
            // The pairing has exactly the authority of the helix.* RPCs: owner only.
            // Anyone else's message still sends, without it.
            if (options?.mayConfigureHelix === false) {
              return {
                pairing: {
                  status: "not_applied",
                  reason: "not_permitted",
                  message: "Only the owner of this computer can turn Helix on or off.",
                },
                afterAccepted: afterAcceptedDetached(goalStartFor(threadId, pairing.messageId)),
              };
            }
            // A retried command whose pairing already ran (also before a restart) does nothing.
            const alreadyApplied = yield* repository
              .hasMessageEffect(pairing.messageId, "pairing")
              .pipe(Effect.orElseSucceed(() => false));
            const plan = alreadyApplied
              ? planOf("unchanged", "none", null)
              : yield* planPairing(ThreadId.makeUnsafe(threadId), pairing.value);
            if (plan.action !== "none") {
              plannedPairings.set(pairing.messageId, {
                threadId: ThreadId.makeUnsafe(threadId),
                pairing: pairing.value,
              });
            }
            return {
              pairing: plan.outcome,
              cancel: Effect.sync(() => {
                plannedPairings.delete(pairing.messageId);
              }),
              // Whichever comes first applies it: this, or the reactor reaching the turn.
              afterAccepted: afterAcceptedDetached(
                Effect.gen(function* () {
                  yield* applyPlannedPairing(pairing.messageId);
                  yield* goalStartFor(threadId, pairing.messageId);
                }),
              ),
            };
          }
          const entry = roles.get(threadId);
          if (!entry?.active) return none;
          switch (command.type) {
            case "thread.turn.interrupt":
            case "thread.session.stop":
              // The user's own command always runs; Helix's Stop is best-effort.
              yield* quietly(
                "user Stop of the pair",
                stopPair(entry.pairId, ThreadId.makeUnsafe(threadId)),
              );
              return none;
            case "thread.turn.start":
              return {
                afterAccepted: afterAcceptedDetached(
                  goalStartFor(threadId, command.message.messageId),
                ),
              };
            case "thread.message.edit-and-resend":
              return {
                afterAccepted: afterAcceptedDetached(goalStartFor(threadId, command.messageId)),
              };
            default:
              return none;
          }
        }),
      // No latch: a message without a planned pairing returns at once; one with a
      // pairing is applied here if afterAccepted has not done it yet (bounded).
      awaitMessagePairing: (_threadId, messageId) =>
        applyPlannedPairing(messageId).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(15),
            onTimeout: () =>
              Effect.logWarning("helix: message pairing did not settle in time", { messageId }),
          }),
        ),
      assertMayMoveWorkspace: (threadId, cwd) =>
        Effect.gen(function* () {
          const refuseMove = HelixServiceError.of(
            HELIX_RPC_ERROR_CODES.unsupportedThread,
            "This workspace belongs to a Helix pair: turn Helix off before moving it.",
            undefined,
            "workspace_in_pair",
          );
          if (roles.get(threadId)?.active) return yield* Effect.fail(refuseMove);
          if (cwd === undefined) return;
          // The git operation acts on the directory: guard every active pair's workspace.
          const target = normalizeWorkspacePath(cwd);
          for (const [participantId, entry] of roles) {
            if (entry.role !== "lead" || !entry.active) continue;
            const lead = yield* Effect.result(
              runtime.getThread(ThreadId.makeUnsafe(participantId)),
            );
            // Another pair that cannot be read never blocks an unrelated thread.
            if (lead._tag === "Failure") continue;
            const paths = [lead.success?.worktreePath, lead.success?.workingDirectory]
              .filter((value): value is string => typeof value === "string" && value.length > 0)
              .map(normalizeWorkspacePath);
            if (paths.some((path) => target === path || target.startsWith(`${path}/`))) {
              return yield* Effect.fail(refuseMove);
            }
          }
        }),
      onDomainEvent: (event) =>
        Effect.gen(function* () {
          const threadId = threadIdOf(event);
          if (threadId === null) return;
          const entry = roles.get(threadId);
          if (!entry || entry.retired) return;
          if (event.type === "thread.deleted" && entry.quarantined) {
            // Deleting either chat of a quarantined pair removes the pair (and,
            // for the Lead, its Builder): the remaining chat becomes ordinary.
            yield* removePairById(entry.pairId, {
              deleteBuilder: entry.role === "lead",
            });
            return;
          }
          if (entry.quarantined) return;
          if (entry.role === "builder") {
            if (event.type === "thread.deleted") {
              yield* onBuilderDeleted(entry.pairId, ThreadId.makeUnsafe(threadId));
              return;
            }
            if (BUILDER_SETTLE_EVENT_TYPES.has(event.type)) yield* checkBuilder(entry.pairId);
            return;
          }
          if (event.type === "thread.archived") yield* onLeadArchived(entry.pairId, event.sequence);
          else if (event.type === "thread.unarchived")
            yield* onLeadUnarchived(entry.pairId, event.sequence);
          else if (event.type === "thread.deleted") yield* onLeadDeleted(entry.pairId);
        }).pipe((effect) => quietly(`event ${event.type}`, effect)),
      sweep: () =>
        Effect.gen(function* () {
          if (!rolesLoaded) yield* loadRoles;
          // Stops that could not commit are retried first, whatever the setting.
          for (const pairId of Array.from(stopFences)) {
            if (quarantinedPairs.has(pairId)) continue;
            yield* quietly("fenced stop retry", stopPairDurably(pairId as HelixPairId));
          }
          const enabled = yield* deps.isEnabled;
          if (enabled !== settingOn) {
            // The Lead's tools follow the setting; Builders stay restricted.
            settingOn = enabled;
            yield* loadRoles;
          }
          if (!enabled) return;
          yield* quietly("role text upgrade", upgradeRolePrompts());
          for (const pairId of Array.from(pendingPairs)) {
            yield* quietly("pending change", applyPendingIfIdle(pairId as HelixPairId));
          }
          if (reconcilePending) {
            reconcilePending = false;
            yield* reconcileStartup();
          }
          const pairIds = yield* unresolvedPairIds();
          for (const pairId of pairIds) {
            if (quarantinedPairs.has(pairId) || stopFences.has(pairId)) continue;
            yield* quietly("sweep", sweepPair(pairId));
          }
        }).pipe((effect) => quietly("sweep", effect)),
      reconcileStartup: () =>
        Effect.gen(function* () {
          // With Helix off, boot does nothing beyond the Builder restrictions above.
          if (!(yield* deps.isEnabled)) {
            reconcilePending = true;
            return;
          }
          yield* reconcileStartup();
        }).pipe((effect) => quietly("startup reconciliation", effect)),
    };

    // ── RPC service ───────────────────────────────────────────────────

    const requireEnabled = Effect.gen(function* () {
      if (!(yield* deps.isEnabled)) {
        return yield* Effect.fail(
          refuse("disabled", "Helix is off. Turn it on in Settings to use it."),
        );
      }
    });

    const viewAfter = (committed: Committed) =>
      Effect.succeed(helixPairView(committed.pair, committed.handoffs));

    const enable: HelixServiceShape["enable"] = (input) =>
      Effect.gen(function* () {
        yield* requireEnabled;
        if (deps.setRoleProfile === undefined) {
          return yield* Effect.fail(
            refuse(
              "storage",
              "Helix cannot restrict a Builder's tools on this server, so it cannot be turned on.",
            ),
          );
        }
        const lead = yield* runtime.getThread(input.leadThreadId);
        if (lead === null || lead.archivedAt != null) {
          return yield* Effect.fail(
            refuse("not_found", "That chat does not exist or is archived."),
          );
        }
        if (roles.get(lead.id)?.role === "builder") {
          return yield* Effect.fail(
            refuse("unsupported_thread", "A Helix Builder cannot lead its own pair."),
          );
        }
        if (
          lead.parentThreadId != null ||
          lead.sidechatSourceThreadId != null ||
          lead.sidechatContext != null ||
          (deps.isHubThread !== undefined && (yield* deps.isHubThread(lead.id)))
        ) {
          return yield* Effect.fail(
            refuse(
              "unsupported_thread",
              "Helix works only in an ordinary chat: not a sub-agent, sidechat or Hub thread.",
            ),
          );
        }
        const existing = yield* repository
          .getPairByLeadThread(lead.id)
          .pipe(Effect.mapError(storage("Could not load the Helix pair.")));
        if (existing !== null) {
          if (existing.lifecycle === "active") return yield* loadView(existing.id);
          if (input.expectedRevision === undefined) {
            return yield* Effect.fail(
              fromTransition({
                code: "stale_revision",
                message: "Pass the pair's revision to turn Helix back on.",
              }),
            );
          }
          const expectedRevision = input.expectedRevision;
          const builderSupport = helixRoleSupport(input.builderModelSelection.provider, "builder");
          if (!builderSupport.supported) {
            return yield* Effect.fail(refuse("unsupported_provider", builderSupport.reason));
          }
          // Re-enable re-caps the Builder to the Lead's mode now (never above it).
          yield* mutate(existing.id, () => ({
            type: "enable",
            expectedRevision,
            builderRuntimeMode: lead.runtimeMode,
            now: now(),
          }));
          const after = yield* mutate(existing.id, (aggregate) => ({
            type: "config.update",
            expectedRevision: aggregate.pair.revision,
            builderModelSelection: input.builderModelSelection,
            ...(input.limits ? { limits: input.limits } : {}),
            // The role text delivered is always the current one; pin it.
            rolePromptVersions: {
              lead: HELIX_ROLE_PROMPT_VERSION,
              builder: HELIX_ROLE_PROMPT_VERSION,
            },
            now: now(),
          }));
          return yield* viewAfter(after);
        }
        const created = createHelixPair({
          pairId: newHelixPairId(),
          projectId: lead.projectId,
          leadThreadId: lead.id,
          leadProvider: lead.modelSelection.provider,
          builderThreadId: newThreadId(),
          builderModelSelection: input.builderModelSelection,
          // Copied from the Lead; Helix never escalates permissions.
          builderRuntimeMode: lead.runtimeMode,
          limits: input.limits ?? DEFAULT_HELIX_LIMITS,
          now: now(),
        });
        if (!created.ok) {
          return yield* Effect.fail(
            created.error.code === "unsupported_provider"
              ? refuse("unsupported_provider", created.error.message)
              : fromTransition(created.error),
          );
        }
        const pair = yield* repository
          .createPair({
            ...created.pair,
            config: {
              ...created.pair.config,
              rolePromptVersions: {
                lead: HELIX_ROLE_PROMPT_VERSION,
                builder: HELIX_ROLE_PROMPT_VERSION,
              },
            },
          })
          .pipe(
            Effect.mapError((error) =>
              error.code === "participant_conflict"
                ? refuse("unsupported_thread", error.message)
                : storage(error.message)(error),
            ),
          );
        // Restricted before the Builder thread exists or any session starts.
        applyRoles(pair);
        yield* publish({ type: "pair-upserted", summary: helixPairSummary(pair, []) });
        return helixPairView(pair, []);
      }).pipe(Effect.mapError(toServiceError));

    const control =
      (type: "pause" | "resume" | "disable") =>
      (input: { readonly pairId: HelixPairId; readonly expectedRevision: number }) =>
        (type === "disable" ? Effect.void : requireEnabled).pipe(
          Effect.andThen(
            mutate(input.pairId, () => ({
              type,
              expectedRevision: input.expectedRevision,
              now: now(),
            })),
          ),
          Effect.flatMap(viewAfter),
          Effect.mapError(toServiceError),
        );

    /** Every readable pair, plus the quarantined ones (one bad row never hides the rest). */
    const listPairs = () =>
      repository.listPairsTolerant().pipe(
        Effect.flatMap((listed) =>
          Effect.gen(function* () {
            for (const row of listed.invalid) {
              yield* quarantine(row, "Its pair record could not be read.");
            }
            const pairs: Array<HelixPairSummary> = [];
            for (const pair of listed.pairs) {
              const latest = yield* repository
                .listHandoffsTolerant(pair.id)
                .pipe(Effect.map((handoffs) => handoffs.handoffs.slice(0, 1)));
              pairs.push(helixPairSummary(pair, latest));
            }
            const quarantined: Array<HelixQuarantinedPair> = [];
            for (const [threadId, entry] of roles) {
              if (entry.role !== "lead" || entry.quarantined !== true) continue;
              quarantined.push({
                pairId: entry.pairId,
                leadThreadId: threadId,
                builderThreadId: entry.counterpartThreadId,
                reason:
                  quarantineReasons.get(entry.pairId) ?? "This pair's data could not be read.",
              });
            }
            return {
              pairs: pairs.filter((summary) => !quarantinedPairs.has(summary.pairId)),
              quarantined,
            };
          }),
        ),
        Effect.mapError((error) => toServiceError(storage("Could not list Helix pairs.")(error))),
      );

    const getPair: HelixServiceShape["getPair"] = ({ leadThreadId }) =>
      roles.get(leadThreadId)?.quarantined === true
        ? Effect.succeed(null)
        : repository.getPairByLeadThread(leadThreadId).pipe(
            Effect.mapError(storage("Could not load the Helix pair.")),
            Effect.flatMap((pair) => (pair === null ? Effect.succeed(null) : loadView(pair.id))),
            Effect.mapError(toServiceError),
          );

    const service: HelixServiceShape = {
      capabilities: () =>
        deps.isEnabled.pipe(
          Effect.map(
            (enabled): HelixCapabilitiesResult => ({
              enabled,
              providers: ProviderKind.literals.map((provider) => {
                const lead = helixRoleSupport(provider, "lead");
                const builder = helixRoleSupport(provider, "builder");
                return {
                  provider,
                  lead: { supported: lead.supported, reason: lead.supported ? null : lead.reason },
                  builder: {
                    supported: builder.supported,
                    reason: builder.supported ? null : builder.reason,
                  },
                };
              }),
              defaultLimits: DEFAULT_HELIX_LIMITS,
            }),
          ),
        ),
      listPairs,
      getPair,
      enable,
      disable: control("disable"),
      pause: control("pause"),
      resume: control("resume"),
      updateConfig: (input) =>
        requireEnabled.pipe(
          Effect.andThen(
            mutate(input.pairId, () => ({
              type: "config.update",
              expectedRevision: input.expectedRevision,
              ...(input.builderModelSelection
                ? { builderModelSelection: input.builderModelSelection }
                : {}),
              ...(input.limits ? { limits: input.limits } : {}),
              now: now(),
            })),
          ),
          // Apply the model to the Builder thread now and surface a refusal; the
          // next brief also carries it explicitly.
          Effect.tap((committed) =>
            input.builderModelSelection === undefined || committed.pair.builderCreatedAt === null
              ? Effect.void
              : runtime
                  .dispatch({
                    type: "thread.meta.update",
                    commandId: CommandId.makeUnsafe(
                      `helix:builder-model:${committed.pair.id}:${committed.pair.revision}`,
                    ),
                    threadId: committed.pair.builderThreadId,
                    modelSelection: committed.pair.config.builderModelSelection,
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      refuse(
                        "storage",
                        `The Builder's model could not be changed: ${error.message}`,
                      ),
                    ),
                  ),
          ),
          Effect.flatMap(viewAfter),
          Effect.mapError(toServiceError),
        ),
      // Stop always wins: no setting check, no revision. If it cannot commit,
      // the pair is still fenced and interrupted, and the error is reported.
      stop: (input) =>
        stopPair(input.pairId).pipe(Effect.flatMap(viewAfter), Effect.mapError(toServiceError)),
      // No setting check: removal must always be possible.
      removePair: (input) =>
        removePairById(input.pairId, { deleteBuilder: false }).pipe(
          Effect.mapError(toServiceError),
        ),
      streamEvents: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const live = yield* Queue.bounded<HelixStreamEvent, Cause.Done>(256);
            const subscription = yield* PubSub.subscribe(events);
            const scoped = (event: HelixStreamEvent) =>
              event.type !== "handoff-upserted" ||
              (input.leadThreadId !== undefined &&
                roles.get(input.leadThreadId)?.pairId === event.handoff.pairId);
            yield* Stream.fromSubscription(subscription).pipe(
              Stream.filter(scoped),
              Stream.runIntoQueue(live),
              Effect.forkScoped,
            );
            const { pairs, quarantined } = yield* listPairs();
            const view =
              input.leadThreadId === undefined
                ? null
                : yield* getPair({ leadThreadId: input.leadThreadId });
            return Stream.concat(
              Stream.succeed({ type: "snapshot" as const, pairs, view, quarantined }),
              Stream.fromQueue(live),
            );
          }),
        ),
    };

    // ── Gateway port ──────────────────────────────────────────────────

    /** The caller's pair, re-resolved from the tables: a capability is never sufficient. */
    const participantPair = (caller: HelixToolCaller) =>
      Effect.gen(function* () {
        yield* requireEnabled;
        const participant = yield* repository
          .getParticipant(caller.threadId)
          .pipe(Effect.mapError(storage("Could not load the Helix pair.")));
        if (participant === null || participant.role !== caller.role) {
          return yield* Effect.fail(
            refuse("not_participant", "This conversation is not a Helix participant in that role."),
          );
        }
        return participant.pair;
      });

    const waitOutput = (
      pair: HelixPair,
      handoff: HelixHandoff,
      flags: {
        readonly replayed: boolean;
        readonly timedOut: boolean;
        readonly alreadyDelivered: boolean;
      },
      hold: HelixHold | null,
    ): HelixHandoffWaitOutput => ({
      pairId: pair.id,
      // A result already delivered is not handed back again; helix_inspect reads it.
      handoff: flags.alreadyDelivered
        ? { ...helixHandoffToolView(handoff), result: null }
        : helixHandoffToolView(handoff),
      replayed: flags.replayed,
      timedOut: flags.timedOut,
      hold,
      message: flags.timedOut
        ? "The Builder is still working. Its result will arrive as a new message: continue with other work or end your turn; do not poll."
        : flags.alreadyDelivered
          ? `Not a new result: handoff ${handoff.sequence} was already delivered to you (${handoff.delivery === "returned_in_tool" ? "as a tool result" : handoff.delivery === "acknowledged" ? "and reviewed" : "as a Helix message"}). It is ${handoff.state}; read it with helix_inspect if needed.`
          : handoff.state === "awaiting_review"
            ? "Review the Builder's result with helix_review. Inspect the worktree before accepting."
            : isHelixHandoffActive(handoff.state)
              ? hold !== null
                ? `Dispatch is held: ${hold.reason}`
                : "The handoff is queued for the Builder."
              : `The handoff ended as ${handoff.state}.`,
    });

    const waitAndReport = (
      pairId: HelixPairId,
      handoff: HelixHandoff,
      seconds: number,
      replayed: boolean,
    ) =>
      Effect.gen(function* () {
        const waited =
          // A pending result is claimed (CAS) even without waiting, so it is never also woken.
          handoff.delivery === "pending" || (seconds > 0 && isHelixHandoffActive(handoff.state))
            ? yield* awaitHandoff(pairId, handoff.id, seconds)
            : {
                handoff,
                timedOut: isHelixHandoffActive(handoff.state) && seconds > 0,
                fresh: false,
              };
        // Only the call that won delivery presents the result as new.
        const alreadyDelivered =
          !waited.fresh &&
          (waited.handoff.delivery === "returned_in_tool" ||
            waited.handoff.delivery === "wake_requested" ||
            waited.handoff.delivery === "wake_dispatched" ||
            waited.handoff.delivery === "acknowledged");
        const pair = yield* repository
          .getPair(pairId)
          .pipe(Effect.mapError(storage("Could not load the Helix pair.")));
        return waitOutput(
          pair!,
          waited.handoff,
          { replayed, timedOut: waited.timedOut, alreadyDelivered },
          pair?.hold ?? null,
        );
      });

    /** A Lead in plan mode cannot edit, so it must not have the Builder edit either. */
    const refuseInPlanMode = (caller: HelixToolCaller) =>
      Effect.gen(function* () {
        const lead = yield* runtime
          .getThread(caller.threadId)
          .pipe(Effect.mapError(storage("Could not read the Lead.")));
        if (lead?.interactionMode === "plan") {
          return yield* Effect.fail(
            fromTransition({
              code: "invalid_transition",
              message:
                "You are in plan mode, which does not change files: present the plan to the user instead of delegating implementation.",
            }),
          );
        }
      });

    const port: HelixGatewayPortShape = {
      delegate: (caller, input) =>
        Effect.gen(function* () {
          const participant = yield* participantPair(caller);
          yield* refuseInPlanMode(caller);
          // A change the user asked for while the pair was busy lands before new work.
          if ((participant.config.pendingChange ?? null) !== null) {
            yield* quietly("pending change", applyPendingIfIdle(participant.id));
          }
          const pair =
            (yield* repository.getPair(participant.id).pipe(Effect.orElseSucceed(() => null))) ??
            participant;
          if (pair.lifecycle !== "active") {
            return yield* Effect.fail(
              fromTransition({
                code: "pair_disabled",
                message: "The user turned Helix off for this chat.",
              }),
            );
          }
          const handoffId = newHelixHandoffId();
          const fingerprint = helixRequestFingerprint({ kind: "delegate", brief: input.brief });
          const committed = yield* mutate(pair.id, () => ({
            type: "delegate",
            handoffId,
            requestId: input.requestId,
            fingerprint,
            brief: input.brief,
            leadTurnId: caller.turnId,
            now: now(),
          }));
          const handoff = committed.transition.handoff;
          if (!handoff) return yield* Effect.fail(refuse("storage", "The handoff was not stored."));
          const current =
            (yield* repository
              .getHandoff(handoff.id)
              .pipe(Effect.mapError(storage("Could not load the handoff.")))) ?? handoff;
          return yield* waitAndReport(
            pair.id,
            current,
            input.waitSeconds ?? HELIX_DEFAULT_WAIT_SECONDS,
            committed.transition.replayed,
          );
        }).pipe(Effect.mapError(toToolError)),
      wait: (caller, input) =>
        Effect.gen(function* () {
          const pair = yield* participantPair(caller);
          const handoffs = yield* repository
            .listHandoffs(pair.id, { limit: 20 })
            .pipe(Effect.mapError(storage("Could not load handoffs.")));
          const handoff =
            input.handoffId !== undefined
              ? (handoffs.find((entry) => entry.id === input.handoffId) ??
                (yield* repository
                  .getHandoff(input.handoffId)
                  .pipe(Effect.mapError(storage("Could not load the handoff.")))))
              : (handoffs.find((entry) => isHelixHandoffActive(entry.state)) ?? handoffs[0]);
          if (!handoff || handoff.pairId !== pair.id) {
            return yield* Effect.fail(
              fromTransition({
                code: "handoff_not_found",
                message: "No such handoff in this pair.",
              }),
            );
          }
          return yield* waitAndReport(
            pair.id,
            handoff,
            input.waitSeconds ?? HELIX_DEFAULT_WAIT_SECONDS,
            false,
          );
        }).pipe(Effect.mapError(toToolError)),
      inspect: (caller, input) =>
        Effect.gen(function* () {
          const pair = yield* participantPair(caller);
          const handoffs = yield* repository
            .listHandoffs(pair.id, { limit: Math.max(20, input.recent ?? 5) })
            .pipe(Effect.mapError(storage("Could not load handoffs.")));
          const selected =
            input.handoffId !== undefined
              ? (handoffs.find((entry) => entry.id === input.handoffId) ??
                (yield* repository
                  .getHandoff(input.handoffId)
                  .pipe(Effect.mapError(storage("Could not load the handoff.")))))
              : (handoffs[0] ?? null);
          if (input.handoffId !== undefined && (!selected || selected.pairId !== pair.id)) {
            return yield* Effect.fail(
              fromTransition({
                code: "handoff_not_found",
                message: "No such handoff in this pair.",
              }),
            );
          }
          const summary = helixPairSummary(pair, handoffs);
          const output: HelixInspectToolOutput = {
            pairId: pair.id,
            builderThreadId: pair.builderThreadId,
            status: summary.status,
            hold: pair.hold,
            goal: pair.goal,
            limits: pair.config.limits,
            handoff: selected
              ? {
                  ...helixHandoffToolView(selected),
                  brief: selected.brief,
                  report: selected.report,
                }
              : null,
            recent: handoffs.slice(0, input.recent ?? 5).map(helixHandoffToolView),
          };
          return output;
        }).pipe(Effect.mapError(toToolError)),
      review: (caller, input) =>
        Effect.gen(function* () {
          const pair = yield* participantPair(caller);
          if (input.verdict === "changes_requested") yield* refuseInPlanMode(caller);
          const reviewed = yield* repository
            .getHandoff(input.handoffId)
            .pipe(Effect.mapError(storage("Could not load the handoff.")));
          if (!reviewed || reviewed.pairId !== pair.id) {
            return yield* Effect.fail(
              fromTransition({
                code: "handoff_not_found",
                message: "No such handoff in this pair.",
              }),
            );
          }
          const feedback = (input.feedback ?? "").trim();
          const { correction: _previous, ...baseBrief } = reviewed.brief;
          const nextBrief = {
            ...baseBrief,
            correction: {
              previousHandoffId: reviewed.id,
              previousResultRevision: reviewed.result?.revision ?? 0,
              feedback: feedback.length > 0 ? feedback : "-",
            },
          };
          const committed = yield* mutate(pair.id, () => ({
            type: "review",
            handoffId: input.handoffId,
            requestId: input.requestId,
            verdict: input.verdict,
            feedback,
            ...(input.expectedResultRevision !== undefined
              ? { expectedResultRevision: input.expectedResultRevision }
              : {}),
            nextHandoffId: newHelixHandoffId(),
            nextFingerprint: helixRequestFingerprint({ kind: "correction", brief: nextBrief }),
            leadTurnId: caller.turnId,
            now: now(),
          }));
          const after = committed.transition.handoff ?? reviewed;
          // Accepted or blocked leaves the pair idle: a pending change lands now.
          if (input.verdict !== "changes_requested") {
            yield* quietly("pending change", applyPendingIfIdle(pair.id));
          }
          const correctionId =
            helixCorrectionCreated(committed.transition)?.id ?? after.review?.nextHandoffId ?? null;
          const next =
            correctionId === null
              ? null
              : yield* Effect.gen(function* () {
                  const correction = yield* repository
                    .getHandoff(correctionId)
                    .pipe(Effect.mapError(storage("Could not load the handoff.")));
                  return correction === null
                    ? null
                    : yield* waitAndReport(
                        pair.id,
                        correction,
                        input.waitSeconds ?? HELIX_DEFAULT_WAIT_SECONDS,
                        committed.transition.replayed,
                      );
                });
          const latestPair = yield* repository
            .getPair(pair.id)
            .pipe(Effect.mapError(storage("Could not load the Helix pair.")));
          const output: HelixReviewToolOutput = {
            pairId: pair.id,
            handoffId: input.handoffId,
            verdict: input.verdict,
            replayed: committed.transition.replayed,
            next,
            hold: latestPair?.hold ?? null,
            message:
              input.verdict === "accepted"
                ? "Recorded as accepted by you. This is not a human code review; tell the user what changed."
                : input.verdict === "blocked"
                  ? "Recorded as blocked. Tell the user what blocks the work."
                  : "The Builder received your consolidated feedback as its next handoff.",
          };
          return output;
        }).pipe(Effect.mapError(toToolError)),
      report: (caller, input) =>
        Effect.gen(function* () {
          const pair = yield* participantPair(caller);
          // The report must come from the brief's own turn. Bind that turn from
          // the projection (never from the caller) and refuse any other turn.
          const handoffs = yield* repository
            .listHandoffs(pair.id, { limit: 5 })
            .pipe(Effect.mapError(storage("Could not load handoffs.")));
          const active = handoffs.find(
            (entry) => entry.state === "running" || entry.state === "dispatching",
          );
          if (active?.dispatch) {
            const intent = active.dispatch;
            const projected =
              active.builderTurnId ??
              (yield* runtime
                .findTurnForMessage(pair.builderThreadId, intent.messageId)
                .pipe(Effect.mapError(storage("Could not read the Builder's turns."))))?.turnId ??
              null;
            if (projected !== null && caller.turnId !== null && projected !== caller.turnId) {
              return yield* Effect.fail(
                fromTransition({
                  code: "no_running_handoff",
                  message:
                    "This report comes from a different turn than the Builder's current brief, so it was not recorded. Finish this turn.",
                }),
              );
            }
            if (projected !== null && active.builderTurnId === null) {
              yield* mutate(pair.id, () => ({
                type: "dispatch.acknowledged",
                handoffId: active.id,
                commandId: intent.commandId,
                builderTurnId: projected,
                now: now(),
              }));
            }
          }
          const committed = yield* mutate(pair.id, () => ({
            type: "report.submit",
            builderTurnId: caller.turnId as TurnId | null,
            report: input,
            now: now(),
          }));
          const handoff = committed.transition.handoff;
          if (!handoff?.report)
            return yield* Effect.fail(refuse("storage", "The report was not stored."));
          const output: HelixReportToolOutput = {
            handoffId: handoff.id,
            reportRevision: handoff.report.reportRevision,
            message:
              "Report recorded. End your turn now; it is delivered to the Lead when your turn ends.",
          };
          return output;
        }).pipe(Effect.mapError(toToolError)),
    };

    return { service, port, hooks } satisfies HelixCoordinator;
  });
