/**
 * Replay proof for assistant deltas of finalized turns.
 *
 * A crash between processing a journal page and acknowledging it replays the
 * page on restart. By then the page's terminal row has finalized the turn, so
 * without proof every replayed delta would take the late path and append its
 * text a second time. This module decides whether such a delta was already
 * applied while its turn was open.
 *
 * Proof is a command receipt: the delta's own streaming receipt, or the
 * completion receipt of a later row of the thread that settled the delta's
 * message. Ingestion runs rows strictly in order, so a later row that ran
 * proves the delta ran before it: streamed, or buffered and flushed by that
 * settle.
 *
 * Reading forward, the first row that must have settled the message if it had
 * run (the message's own item completion, the turn's terminal row, or a
 * session exit, which settles every tracked turn) decides the answer: with a
 * receipt it was applied; without one, either that row never ran, so no
 * later row ran either, or it ran without settling this message, so nothing
 * flushed text of this delta. Either way no later row can hold proof.
 *
 * Every uncertain outcome (a bound reached, a failed read) answers "not
 * proven", which keeps the pre-proof behaviour of applying the delta. A wrong
 * "not proven" can at worst repeat text the old code also repeated; it never
 * drops text.
 *
 * @module ProviderRuntimeIngestion.replayProof
 */
import { Cause, Effect } from "effect";

import type { ProviderRuntimeEventEnvelopeRow } from "../../persistence/Services/ProviderRuntimeEvents.ts";

/**
 * The completion command tags with which a row of each type settles an
 * assistant message: item completion, terminal finalize, session exit,
 * runtime error, and the late-buffer settle on the next turn boundary.
 */
export const ASSISTANT_SETTLE_COMMAND_TAGS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "item.completed": ["assistant-complete"],
  "turn.started": ["assistant-complete-late"],
  "turn.completed": ["assistant-complete-finalize", "assistant-complete-late"],
  "turn.aborted": ["assistant-complete-finalize", "assistant-complete-late"],
  "session.exited": ["assistant-complete-session-exit"],
  "runtime.error": ["assistant-complete-runtime-error"],
};
export const ASSISTANT_SETTLING_EVENT_TYPES = Object.keys(ASSISTANT_SETTLE_COMMAND_TAGS);

/**
 * Thread rows examined after a replayed delta. A lost acknowledgement replays
 * at most one drain page (128 rows), so a settling row that ran lies well
 * inside this bound; past it the delta is applied as before.
 */
export const ASSISTANT_SETTLING_SCAN_LIMIT = 1_024;

export interface AssistantDeltaProofInput {
  readonly eventId: string;
  /** The journal's thread for the row, not the routed projection thread. */
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string | undefined;
  readonly messageId: string;
  readonly runtimeSequence: number;
}

export interface AssistantDeltaProofDependencies<R> {
  readonly hasReceipt: (commandId: string) => Effect.Effect<boolean, unknown, R>;
  readonly readEnvelopesAfter: (input: {
    readonly threadId: string;
    readonly afterSequenceExclusive: number;
    readonly eventTypes: ReadonlyArray<string>;
    readonly scanLimit: number;
  }) => Effect.Effect<ReadonlyArray<ProviderRuntimeEventEnvelopeRow>, unknown, R>;
  readonly commandId: (eventId: string, tag: string, target: string) => string;
  readonly onLookupFailure: (cause: Cause.Cause<unknown>) => Effect.Effect<void, never, R>;
}

/** A row that, once run, must have settled the message: its missing receipt decides. */
function decidesMessage(row: ProviderRuntimeEventEnvelopeRow, input: AssistantDeltaProofInput) {
  switch (row.eventType) {
    case "item.completed":
      return (
        row.itemType === "assistant_message" &&
        input.itemId !== undefined &&
        row.itemId === input.itemId
      );
    case "turn.completed":
    case "turn.aborted":
      return row.turnId === input.turnId;
    case "session.exited":
      return true;
    default:
      return false;
  }
}

/**
 * True only with receipt proof that the delta was already applied. Never
 * fails: a lookup failure is reported once through `onLookupFailure` and
 * answers "not proven", so an unrelated unreadable row cannot block the delta.
 */
export const proveAssistantDeltaApplied = <R>(
  dependencies: AssistantDeltaProofDependencies<R>,
  input: AssistantDeltaProofInput,
): Effect.Effect<boolean, never, R> =>
  Effect.gen(function* () {
    const settledBy = (eventId: string, tag: string) =>
      dependencies.hasReceipt(dependencies.commandId(eventId, tag, input.messageId));
    if (yield* settledBy(input.eventId, "assistant-delta")) return true;
    const rows = yield* dependencies.readEnvelopesAfter({
      threadId: input.threadId,
      afterSequenceExclusive: input.runtimeSequence,
      eventTypes: ASSISTANT_SETTLING_EVENT_TYPES,
      scanLimit: ASSISTANT_SETTLING_SCAN_LIMIT,
    });
    for (const row of rows) {
      for (const tag of ASSISTANT_SETTLE_COMMAND_TAGS[row.eventType] ?? []) {
        if (yield* settledBy(row.eventId, tag)) return true;
      }
      if (decidesMessage(row, input)) return false;
    }
    return false;
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : dependencies.onLookupFailure(cause).pipe(Effect.as(false)),
    ),
  );
