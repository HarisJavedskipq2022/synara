import { it as effectIt } from "@effect/vitest";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

import {
  OrchestrationCommandAdmissionError,
  OrchestrationCommandIdentityCollisionError,
  OrchestrationCommandInternalError,
  OrchestrationCommandInvariantError,
  OrchestrationCommandPreviouslyRejectedError,
  OrchestrationCommandTimeoutError,
} from "../orchestration/Errors.ts";
import { isHelixDispatchRejection, makeLiveHelixRuntime } from "./runtime.ts";

const layer = effectIt.layer(SqlitePersistenceMemory);

describe("Helix dispatch failure classification", () => {
  it("treats only decider refusals as rejections", () => {
    expect(
      isHelixDispatchRejection(
        new OrchestrationCommandInvariantError({ commandType: "thread.turn.start", detail: "no" }),
      ),
    ).toBe(true);
    expect(
      isHelixDispatchRejection(
        new OrchestrationCommandPreviouslyRejectedError({ commandId: "c", detail: "no" }),
      ),
    ).toBe(true);
  });

  it("leaves timeouts, admission, internal failures and collisions unknown", () => {
    for (const cause of [
      new OrchestrationCommandTimeoutError({
        commandId: "c",
        commandType: "thread.turn.start",
        timeoutMs: 1,
      }),
      new OrchestrationCommandAdmissionError({
        commandId: "c",
        commandType: "thread.turn.start",
        capacity: 1,
        reservedCapacity: 0,
        reason: "overloaded",
      }),
      new OrchestrationCommandInternalError({
        commandId: "c",
        commandType: "thread.turn.start",
        detail: "boom",
      }),
      new OrchestrationCommandIdentityCollisionError({ commandId: "c", detail: "bound" }),
      new Error("anything else"),
    ]) {
      expect(isHelixDispatchRejection(cause)).toBe(false);
    }
  });
});

const collisionRuntime = (status: "accepted" | "rejected" | null) =>
  makeLiveHelixRuntime({
    engine: {
      dispatch: () =>
        Effect.fail(
          new OrchestrationCommandIdentityCollisionError({ commandId: "helix:x", detail: "bound" }),
        ),
    } as never,
    snapshotQuery: {} as never,
    projectionTurns: {} as never,
    deliveries: {} as never,
    receipts: {
      getByCommandId: () =>
        Effect.succeed(
          status === null ? Option.none() : Option.some({ status, resultSequence: 41 } as never),
        ),
    } as never,
  });

const command = {
  type: "thread.meta.update",
  commandId: "helix:x",
  threadId: "t",
  title: "T",
} as never;

layer("Helix runtime dispatch on an identity collision", (it) => {
  it.effect("is the accepted command when its receipt is accepted", () =>
    Effect.gen(function* () {
      const runtime = yield* collisionRuntime("accepted");
      expect(yield* runtime.dispatch(command)).toEqual({ sequence: 41 });
    }),
  );

  it.effect("is an unknown outcome (not a rejection) otherwise", () =>
    Effect.gen(function* () {
      for (const status of ["rejected", null] as const) {
        const runtime = yield* collisionRuntime(status);
        const error = yield* Effect.flip(runtime.dispatch(command));
        expect(error.rejected).toBe(false);
      }
    }),
  );
});
