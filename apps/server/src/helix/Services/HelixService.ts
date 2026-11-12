/**
 * HelixService - the server side of the helix.* RPCs.
 *
 * The foundation layer (`Layers/HelixService.ts`) serves the reads from the
 * repository and refuses every mutation with HELIX_NOT_IMPLEMENTED; the
 * coordinator stage replaces that layer with the real one behind this same
 * shape (docs/plans/helix-prototype.md, "RPC surface").
 *
 * @module helix/Services/HelixService
 */
import type {
  HelixCapabilitiesResult,
  HelixEnableInput,
  HelixGetPairInput,
  HelixGetPairResult,
  HelixListPairsResult,
  HelixPairControlInput,
  HelixPairView,
  HelixRemovePairInput,
  HelixRemovePairResult,
  HelixRpcErrorCode,
  HelixStopInput,
  HelixStreamEvent,
  HelixSubscribeInput,
  HelixUpdateConfigInput,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export class HelixServiceError extends Schema.TaggedErrorClass<HelixServiceError>()(
  "HelixServiceError",
  {
    /** One of HELIX_RPC_ERROR_CODES; travels to the client as `WsRpcError.code`. */
    code: Schema.String,
    message: Schema.String,
    /** A finer reason (`HelixRefusalReason`); travels as `WsRpcError.reason`. */
    reason: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {
  static of(
    code: HelixRpcErrorCode,
    message: string,
    cause?: unknown,
    reason?: string,
  ): HelixServiceError {
    return new HelixServiceError({
      code,
      message,
      ...(cause === undefined ? {} : { cause }),
      ...(reason === undefined ? {} : { reason }),
    });
  }
}

export interface HelixServiceShape {
  readonly capabilities: () => Effect.Effect<HelixCapabilitiesResult, HelixServiceError>;
  /** Every pair, active or disabled. The web hides Builder threads by this list. */
  readonly listPairs: () => Effect.Effect<HelixListPairsResult, HelixServiceError>;
  readonly getPair: (
    input: HelixGetPairInput,
  ) => Effect.Effect<HelixGetPairResult, HelixServiceError>;
  readonly enable: (input: HelixEnableInput) => Effect.Effect<HelixPairView, HelixServiceError>;
  /** Remove a pair by id without reading it (the way out of quarantine). */
  readonly removePair: (
    input: HelixRemovePairInput,
  ) => Effect.Effect<HelixRemovePairResult, HelixServiceError>;
  readonly disable: (
    input: HelixPairControlInput,
  ) => Effect.Effect<HelixPairView, HelixServiceError>;
  readonly updateConfig: (
    input: HelixUpdateConfigInput,
  ) => Effect.Effect<HelixPairView, HelixServiceError>;
  readonly pause: (input: HelixPairControlInput) => Effect.Effect<HelixPairView, HelixServiceError>;
  readonly resume: (
    input: HelixPairControlInput,
  ) => Effect.Effect<HelixPairView, HelixServiceError>;
  readonly stop: (input: HelixStopInput) => Effect.Effect<HelixPairView, HelixServiceError>;
  /** A `snapshot` first, then upserts as transitions commit. */
  readonly streamEvents: (
    input: HelixSubscribeInput,
  ) => Stream.Stream<HelixStreamEvent, HelixServiceError>;
}

export class HelixService extends ServiceMap.Service<HelixService, HelixServiceShape>()(
  "synara/helix/Services/HelixService",
) {}
