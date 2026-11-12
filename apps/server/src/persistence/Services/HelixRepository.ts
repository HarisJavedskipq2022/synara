/**
 * HelixRepository - durable state for Helix Lead/Builder pairs.
 *
 * A state-table aggregate (docs/plans/helix-prototype.md, "Storage"): a pair
 * row and its handoff rows change together in one transaction, guarded by the
 * pair's revision. The repository enforces the invariants the database can
 * state on its own (one active handoff per pair, request-id identity, one pair
 * per participant thread); every lifecycle rule lives in the pure state
 * machine (`helix/stateMachine.ts`), which produces the rows committed here.
 *
 * @module persistence/Services/HelixRepository
 */
import type {
  HelixHandoff,
  HelixHandoffId,
  HelixPair,
  HelixPairId,
  HelixRole,
  ThreadId,
} from "@synara/contracts";
import { Effect, Schema, ServiceMap } from "effect";

export const HelixRepositoryErrorCode = Schema.Literals([
  "storage",
  "not_found",
  /** The pair's revision moved since the caller read it. */
  "stale_revision",
  /** A handoff's own revision moved since the caller read it. */
  "stale_handoff_revision",
  /** The request id already names a handoff with the same fingerprint: replay it. */
  "duplicate_request",
  /** The request id already names a handoff with different content. */
  "request_conflict",
  /** The pair already has a prepared, dispatching or running handoff. */
  "active_handoff_exists",
  /** A thread already participates in another pair (in either role). */
  "participant_conflict",
]);
export type HelixRepositoryErrorCode = typeof HelixRepositoryErrorCode.Type;

export class HelixRepositoryError extends Schema.TaggedErrorClass<HelixRepositoryError>()(
  "HelixRepositoryError",
  {
    message: Schema.String,
    code: HelixRepositoryErrorCode,
    /** For duplicate_request and request_conflict: the existing handoff. */
    existingHandoffId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface HelixParticipant {
  readonly pair: HelixPair;
  readonly role: HelixRole;
}

/** Which kind of server-originated turn a `helix:` command id belongs to. */
export type HelixAutomaticTurnKind = "dispatch" | "wake";

export interface HelixAutomaticTurn {
  readonly kind: HelixAutomaticTurnKind;
  readonly pair: HelixPair;
  readonly handoff: HelixHandoff;
}

/** A handoff write inside a commit: a new row, or an update guarded by its revision. */
export type HelixHandoffWrite =
  | { readonly kind: "insert"; readonly handoff: HelixHandoff }
  | {
      readonly kind: "update";
      readonly handoff: HelixHandoff;
      readonly expectedRevision: number;
    };

export interface HelixCommitInput {
  /**
   * The next pair row. `expectedRevision` is the revision the caller read;
   * `pair.revision` must be exactly one more.
   */
  readonly pair: HelixPair;
  readonly expectedRevision: number;
  readonly handoffs: ReadonlyArray<HelixHandoffWrite>;
}

export interface HelixRepositoryShape {
  /**
   * Insert a new pair at revision 0. Fails with `participant_conflict` when
   * either thread already participates in any pair, in either role.
   */
  readonly createPair: (pair: HelixPair) => Effect.Effect<HelixPair, HelixRepositoryError>;
  readonly getPair: (pairId: HelixPairId) => Effect.Effect<HelixPair | null, HelixRepositoryError>;
  readonly getPairByLeadThread: (
    threadId: ThreadId,
  ) => Effect.Effect<HelixPair | null, HelixRepositoryError>;
  /** The pair a thread belongs to and its role, whichever side it is on. */
  readonly getParticipant: (
    threadId: ThreadId,
  ) => Effect.Effect<HelixParticipant | null, HelixRepositoryError>;
  readonly listPairs: () => Effect.Effect<ReadonlyArray<HelixPair>, HelixRepositoryError>;
  /**
   * Every pair row, decoding each one separately: a row that no longer decodes
   * is returned in `invalid` with the participant ids its typed columns hold, so
   * the caller can still restrict its Builder (fail closed) and quarantine it.
   */
  readonly listPairsTolerant: () => Effect.Effect<
    {
      readonly pairs: ReadonlyArray<HelixPair>;
      readonly invalid: ReadonlyArray<{
        readonly pairId: string;
        readonly leadThreadId: string;
        readonly builderThreadId: string;
      }>;
    },
    HelixRepositoryError
  >;
  /**
   * Atomically write the next pair row and its changed handoffs. All or
   * nothing: any failed guard rolls the whole commit back.
   */
  readonly commit: (input: HelixCommitInput) => Effect.Effect<
    {
      readonly pair: HelixPair;
      readonly handoffs: ReadonlyArray<HelixHandoff>;
    },
    HelixRepositoryError
  >;
  readonly getHandoff: (
    handoffId: HelixHandoffId,
  ) => Effect.Effect<HelixHandoff | null, HelixRepositoryError>;
  readonly findHandoffByRequestId: (
    pairId: HelixPairId,
    requestId: string,
  ) => Effect.Effect<HelixHandoff | null, HelixRepositoryError>;
  /** Newest first. */
  readonly listHandoffs: (
    pairId: HelixPairId,
    options?: { readonly limit?: number },
  ) => Effect.Effect<ReadonlyArray<HelixHandoff>, HelixRepositoryError>;
  /**
   * Handoffs a restart must reconcile: prepared, dispatching, running or
   * awaiting_review, or with a pending/requested delivery. Oldest first.
   */
  /**
   * Every handoff of a pair, newest first, skipping rows that do not decode
   * (their ids are returned so the pair can be quarantined, never failed).
   */
  readonly listHandoffsTolerant: (
    pairId: HelixPairId,
  ) => Effect.Effect<
    { readonly handoffs: ReadonlyArray<HelixHandoff>; readonly invalid: ReadonlyArray<string> },
    HelixRepositoryError
  >;
  /** `listUnresolvedHandoffs` that skips undecodable rows and names their pairs. */
  readonly listUnresolvedHandoffsTolerant: () => Effect.Effect<
    {
      readonly handoffs: ReadonlyArray<HelixHandoff>;
      readonly invalidPairIds: ReadonlyArray<string>;
    },
    HelixRepositoryError
  >;
  readonly listUnresolvedHandoffs: () => Effect.Effect<
    ReadonlyArray<HelixHandoff>,
    HelixRepositoryError
  >;
  /**
   * Resolve a `thread.turn.start` command id to the handoff whose current
   * dispatch or wake intent carries it. Null for any other command id,
   * including a superseded attempt of a Helix command.
   */
  readonly findAutomaticTurn: (
    commandId: string,
  ) => Effect.Effect<HelixAutomaticTurn | null, HelixRepositoryError>;
  /**
   * Remove a pair and all of its handoffs, without decoding them. Threads in
   * `retireThreadIds` are retired in the same transaction.
   */
  readonly deletePair: (
    pairId: HelixPairId,
    options?: { readonly retireThreadIds?: ReadonlyArray<string> },
  ) => Effect.Effect<void, HelixRepositoryError>;
  /** Mark a former Builder thread retired for good (idempotent). */
  readonly retireThread: (
    threadId: string,
    pairId: string,
  ) => Effect.Effect<void, HelixRepositoryError>;
  /**
   * Claim a user message's Helix effect (`pairing` or `goal`) once, durably:
   * true only the first time. A retried command claims nothing again.
   */
  readonly claimMessageEffect: (
    messageId: string,
    effect: "pairing" | "goal",
  ) => Effect.Effect<boolean, HelixRepositoryError>;
  readonly hasMessageEffect: (
    messageId: string,
    effect: "pairing" | "goal",
  ) => Effect.Effect<boolean, HelixRepositoryError>;
  /** A Stop the user asked for that Helix could not commit (no decoding needed). */
  readonly recordStopRequest: (pairId: string) => Effect.Effect<void, HelixRepositoryError>;
  readonly clearStopRequest: (pairId: string) => Effect.Effect<void, HelixRepositoryError>;
  readonly listStopRequests: () => Effect.Effect<ReadonlyArray<string>, HelixRepositoryError>;
  /** Every retired former Builder thread. */
  readonly listRetiredThreads: () => Effect.Effect<
    ReadonlyArray<{ readonly threadId: string; readonly pairId: string }>,
    HelixRepositoryError
  >;
}

export class HelixRepository extends ServiceMap.Service<HelixRepository, HelixRepositoryShape>()(
  "synara/persistence/Services/HelixRepository",
) {}
