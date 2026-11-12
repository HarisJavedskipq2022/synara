/**
 * HelixRuntime - the narrow view of the orchestration engine the Helix
 * coordinator needs. The live implementation reads projections, the provider
 * runtime journal and the command ledger; tests substitute a fake so the
 * coordinator's logic runs without providers.
 *
 * @module helix/runtime
 */
import {
  CommandId,
  type MessageId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ThreadId,
  type TurnId,
} from "@synara/contracts";
import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeCompletionRepository } from "../agentGateway/completionRepository.ts";
import {
  OrchestrationCommandIdentityCollisionError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
} from "../orchestration/Errors.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationCommandReceiptRepositoryShape } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  PROVIDER_COMMAND_REACTOR_CONSUMER,
  type OrchestrationEventDeliveryRepositoryShape,
} from "../persistence/Services/OrchestrationEventDeliveries.ts";
import type { ProjectionTurnRepositoryShape } from "../persistence/Services/ProjectionTurns.ts";

export class HelixRuntimeError extends Schema.TaggedErrorClass<HelixRuntimeError>()(
  "HelixRuntimeError",
  {
    message: Schema.String,
    /** True when the engine refused the command (as opposed to a storage failure). */
    rejected: Schema.Boolean,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/** The Builder turn a dispatched brief started. */
export interface HelixTurnObservation {
  readonly turnId: TurnId | null;
  readonly state: "pending" | "running" | "interrupted" | "completed" | "error";
}

/** Provider-delivery outcome of the turn-start intent a message produced. */
export type HelixDeliveryObservation =
  | "none"
  | "inflight"
  | "retry"
  | "succeeded"
  | "dead"
  | "uncertain";

export interface HelixRuntimeShape {
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, HelixRuntimeError>;
  readonly getThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationThreadShell | null, HelixRuntimeError>;
  readonly findTurnForMessage: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<HelixTurnObservation | null, HelixRuntimeError>;
  /** The provider journal recorded a successful terminal event for the turn. */
  readonly hasCompletedRun: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<boolean, HelixRuntimeError>;
  /** Every provider runtime event of the thread has been ingested. */
  readonly isOutputSettled: (threadId: ThreadId) => Effect.Effect<boolean, HelixRuntimeError>;
  readonly finalAssistantText: (
    threadId: ThreadId,
    turnId: TurnId,
  ) => Effect.Effect<string | null, HelixRuntimeError>;
  /** The session failed or stopped after the turn-start intent, before any turn existed. */
  readonly initialFailure: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<{ readonly error: string | null } | null, HelixRuntimeError>;
  readonly deliveryState: (
    threadId: ThreadId,
    messageId: MessageId,
  ) => Effect.Effect<HelixDeliveryObservation, HelixRuntimeError>;
  /** The engine holds an accepted receipt for the command id. */
  readonly commandAccepted: (commandId: string) => Effect.Effect<boolean, HelixRuntimeError>;
}

/**
 * Whether an engine dispatch failure is a refusal (the decider said no, now or
 * before). Timeouts, admission and internal failures leave the outcome unknown;
 * an identity collision is resolved from the receipt by the caller.
 */
export function isHelixDispatchRejection(cause: unknown): boolean {
  return (
    cause instanceof OrchestrationCommandInvariantError ||
    cause instanceof OrchestrationCommandPreviouslyRejectedError
  );
}

const storage = (message: string) => (cause: unknown) =>
  new HelixRuntimeError({ message, rejected: false, cause });

export const makeLiveHelixRuntime = (input: {
  readonly engine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly projectionTurns: ProjectionTurnRepositoryShape;
  readonly receipts: OrchestrationCommandReceiptRepositoryShape;
  readonly deliveries: OrchestrationEventDeliveryRepositoryShape;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const completions = yield* makeCompletionRepository;

    const runtime: HelixRuntimeShape = {
      dispatch: (command) =>
        input.engine.dispatch(command).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const message = cause instanceof Error ? cause.message : String(cause);
              // An identity collision or a receipt race means this command id is
              // already bound: when that receipt is accepted, the command is.
              if (cause instanceof OrchestrationCommandIdentityCollisionError) {
                const receipt = yield* input.receipts
                  .getByCommandId({ commandId: command.commandId })
                  .pipe(Effect.orElseSucceed(() => Option.none()));
                if (Option.isSome(receipt) && receipt.value.status === "accepted") {
                  return { sequence: receipt.value.resultSequence };
                }
                return yield* new HelixRuntimeError({ message, rejected: false, cause });
              }
              // Only the decider's refusal (or its recorded refusal) is a rejection;
              // timeouts, admission and internal failures leave the outcome unknown.
              return yield* new HelixRuntimeError({
                message,
                rejected: isHelixDispatchRejection(cause),
                cause,
              });
            }),
          ),
        ),
      getThread: (threadId) =>
        input.snapshotQuery
          .getThreadShellById(threadId)
          .pipe(
            Effect.map(Option.getOrNull),
            Effect.mapError(storage("Could not read the thread.")),
          ),
      findTurnForMessage: (threadId, messageId) =>
        input.projectionTurns.listByThreadId({ threadId }).pipe(
          Effect.map((turns) => {
            const turn = turns.findLast((entry) => entry.pendingMessageId === messageId);
            return turn ? { turnId: turn.turnId, state: turn.state } : null;
          }),
          Effect.mapError(storage("Could not read the Builder's turns.")),
        ),
      hasCompletedRun: (threadId, turnId) =>
        completions
          .hasCompletedRun(threadId, turnId)
          .pipe(Effect.mapError(storage("Could not read the provider journal."))),
      isOutputSettled: (threadId) =>
        completions
          .isOutputSettled(threadId)
          .pipe(Effect.mapError(storage("Could not read the provider journal."))),
      finalAssistantText: (threadId, turnId) =>
        input.snapshotQuery.getThreadDetailById(threadId).pipe(
          Effect.map((detail) => {
            const thread = Option.getOrUndefined(detail);
            const message = thread?.messages.findLast(
              (entry) => entry.role === "assistant" && entry.turnId === turnId,
            );
            return message?.text ?? null;
          }),
          Effect.mapError(storage("Could not read the Builder's messages.")),
        ),
      initialFailure: (threadId, messageId) =>
        completions.initialFailure(threadId, messageId).pipe(
          Effect.map((row) => (row === null ? null : { error: row.error })),
          Effect.mapError(storage("Could not read the Builder's session history.")),
        ),
      deliveryState: (threadId, messageId) =>
        Effect.gen(function* () {
          const [row] = yield* sql<{ readonly sequence: number }>`
            SELECT sequence FROM orchestration_events
            WHERE stream_id = ${threadId} AND event_type = 'thread.turn-start-requested'
              AND json_extract(payload_json, '$.messageId') = ${messageId}
            ORDER BY sequence DESC LIMIT 1
          `;
          if (!row) return "none" as const;
          const delivery = yield* input.deliveries.getDelivery({
            consumerName: PROVIDER_COMMAND_REACTOR_CONSUMER,
            eventSequence: row.sequence,
          });
          return Option.isSome(delivery) ? delivery.value.state : ("none" as const);
        }).pipe(Effect.mapError(storage("Could not read the provider delivery journal."))),
      commandAccepted: (commandId) =>
        input.receipts.getByCommandId({ commandId: CommandId.makeUnsafe(commandId) }).pipe(
          Effect.map((receipt) => Option.isSome(receipt) && receipt.value.status === "accepted"),
          Effect.mapError(storage("Could not read the command ledger.")),
        ),
    };
    return runtime;
  });
