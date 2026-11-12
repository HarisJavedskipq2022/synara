/**
 * Regression tests adopted from the fourth review pass (S1, S2): the pairing on
 * a message survives an interrupted dispatch and is applied exactly once,
 * durably, across a restart.
 */
import {
  ModelSelection,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";

import { HelixRepositoryLive } from "../persistence/Layers/HelixRepository.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  HelixRepository,
  type HelixRepositoryShape,
} from "../persistence/Services/HelixRepository.ts";
import { makeHelixCoordinator } from "./coordinator.ts";
import {
  HelixRuntimeError,
  type HelixDeliveryObservation,
  type HelixRuntimeShape,
  type HelixTurnObservation,
} from "./runtime.ts";
import type { HelixToolCaller } from "./Services/HelixGatewayPort.ts";

const NOW = "2026-11-12T10:00:00.000Z";
const PROJECT = ProjectId.makeUnsafe("project");
const codex = Schema.decodeSync(ModelSelection)({ provider: "codex", model: "gpt-5" });
const claude = Schema.decodeSync(ModelSelection)({ provider: "claudeAgent", model: "sonnet" });

function shell(id: string, o: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: PROJECT,
    title: `Thread ${id}`,
    modelSelection: claude,
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: "worktree",
    branch: "b",
    worktreePath: "/tmp/w",
    workingDirectory: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: true,
    isPinned: false,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: null,
    latestUserMessageAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    handoff: null,
    session: null,
    ...o,
  } as OrchestrationThreadShell;
}

class Fake {
  threads = new Map<string, OrchestrationThreadShell>();
  commands: OrchestrationCommand[] = [];
  accepted = new Set<string>();
  rejected = new Set<string>();
  turns = new Map<string, HelixTurnObservation>();
  completed = new Set<string>();
  unsettled = new Set<string>();
  texts = new Map<string, string>();
  deliveries = new Map<string, HelixDeliveryObservation>();
  rejectTypes = new Set<string>();
  starts(threadId: string) {
    return this.commands.filter((c) => c.type === "thread.turn.start" && c.threadId === threadId);
  }
  settle(
    threadId: string,
    messageId: string,
    turnId: string,
    state: HelixTurnObservation["state"],
  ) {
    this.turns.set(`${threadId}|${messageId}`, { turnId: TurnId.makeUnsafe(turnId), state });
    if (state === "completed") this.completed.add(turnId);
    this.texts.set(turnId, "final text");
  }
  shape: HelixRuntimeShape = {
    dispatch: (command) =>
      Effect.suspend(() => {
        // Like the real engine: a rejected command id stays rejected (receipt).
        if (this.rejected.has(command.commandId) || this.rejectTypes.has(command.type)) {
          this.rejected.add(command.commandId);
          return Effect.fail(new HelixRuntimeError({ message: "refused", rejected: true }));
        }
        if (this.accepted.has(command.commandId)) return Effect.succeed({ sequence: 0 });
        this.accepted.add(command.commandId);
        this.commands.push(command);
        if (command.type === "thread.create") {
          this.threads.set(command.threadId, shell(command.threadId, { title: command.title }));
        }
        return Effect.succeed({ sequence: this.commands.length });
      }),
    getThread: (id) => Effect.succeed(this.threads.get(id) ?? null),
    findTurnForMessage: (t, m) => Effect.succeed(this.turns.get(`${t}|${m}`) ?? null),
    hasCompletedRun: (_t, turnId) => Effect.succeed(this.completed.has(turnId)),
    isOutputSettled: (t) => Effect.succeed(!this.unsettled.has(t)),
    finalAssistantText: (_t, turnId) => Effect.succeed(this.texts.get(turnId) ?? null),
    initialFailure: () => Effect.succeed(null),
    deliveryState: (t, m) => Effect.succeed(this.deliveries.get(`${t}|${m}`) ?? "none"),
    commandAccepted: (id) => Effect.succeed(this.accepted.has(id)),
  };
}

let n = 0;
const setup = (
  o: {
    fake?: Fake;
    leadRuntimeMode?: "approval-required" | "full-access";
    repository?: (r: HelixRepositoryShape) => HelixRepositoryShape;
  } = {},
) =>
  Effect.gen(function* () {
    n += 1;
    const leadId = `rv-lead-${n}`;
    const builderId = `rv-builder-${n}`;
    const fake = o.fake ?? new Fake();
    fake.threads.set(
      leadId,
      shell(leadId, { runtimeMode: o.leadRuntimeMode ?? "approval-required" }),
    );
    const base = yield* HelixRepository;
    const repository = o.repository ? o.repository(base) : base;
    const enabled = yield* Ref.make(true);
    const profiles = new Map<string, unknown>();
    const deps = {
      repository,
      runtime: fake.shape,
      isEnabled: Ref.get(enabled),
      setRoleProfile: (t: string, p: unknown) => {
        profiles.set(t, p);
      },
      newThreadId: () => ThreadId.makeUnsafe(builderId),
    };
    const coordinator = yield* makeHelixCoordinator(deps);
    yield* coordinator.service.enable({
      leadThreadId: ThreadId.makeUnsafe(leadId),
      builderModelSelection: codex,
    });
    const pair = () =>
      base.getPairByLeadThread(ThreadId.makeUnsafe(leadId)).pipe(
        Effect.orDie,
        Effect.map((p) => p!),
      );
    const latest = () =>
      pair().pipe(
        Effect.flatMap((p) => base.listHandoffs(p.id)),
        Effect.orDie,
        Effect.map((h) => h[0]!),
      );
    const lead: HelixToolCaller = {
      threadId: ThreadId.makeUnsafe(leadId),
      turnId: TurnId.makeUnsafe("lt"),
      sessionKey: "l",
      provider: "claudeAgent",
      role: "lead",
    };
    const builder = (turnId: string): HelixToolCaller => ({
      threadId: ThreadId.makeUnsafe(builderId),
      turnId: TurnId.makeUnsafe(turnId),
      sessionKey: "b",
      provider: "codex",
      role: "builder",
    });
    const restart = () =>
      Effect.gen(function* () {
        const c = yield* makeHelixCoordinator({ ...deps, repository: base });
        yield* c.hooks.reconcileStartup();
        return c;
      });
    return {
      fake,
      coordinator,
      pair,
      latest,
      lead,
      builder,
      restart,
      leadId,
      builderId,
      base,
      enabled,
      profiles,
    };
  });

const layer = it.layer(HelixRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const msg = (leadId: string, messageId: string, helix?: unknown): OrchestrationCommand =>
  ({
    type: "thread.turn.start",
    commandId: `c-${messageId}` as never,
    threadId: ThreadId.makeUnsafe(leadId),
    message: { messageId: messageId as never, role: "user", text: "hi", attachments: [] },
    dispatchMode: "queue",
    runtimeMode: "approval-required",
    interactionMode: "default",
    ...(helix === undefined ? {} : { helix }),
    createdAt: NOW,
  }) as unknown as OrchestrationCommand;
const on = { enabled: true, builderModelSelection: codex };
const off = { enabled: false };

layer("Helix review round 4 regressions (message pairing)", (it) => {
  describe("S1 latch when the dispatch RPC is interrupted", () => {
    it.effect("an interrupted dispatch releases the pairing latch (wsRpc uses tapError only)", () =>
      Effect.gen(function* () {
        const h = yield* setup();
        const p = yield* h.pair();
        yield* h.coordinator.service.disable({ pairId: p.id, expectedRevision: p.revision });
        const intercepted = yield* h.coordinator.hooks.interceptClientCommand(
          msg(h.leadId, "m-int", on),
        );
        // Exactly what wsRpc does: dispatch.pipe(tapError(cancel)), then afterAccepted.
        const rpc = yield* Effect.gen(function* () {
          yield* Effect.never.pipe(
            Effect.tapError(
              () => (intercepted as { cancel?: Effect.Effect<void> }).cancel ?? Effect.void,
            ),
          );
          yield* intercepted.afterAccepted;
        }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(rpc); // the client's connection closed
        const waiting = yield* h.coordinator.hooks
          .awaitMessagePairing(ThreadId.makeUnsafe(h.leadId), "m-int")
          .pipe(Effect.forkChild);
        yield* TestClock.adjust(Duration.seconds(14));
        // Let the (real, fast) apply finish; only the 15 s timeout needs the test clock.
        yield* Effect.yieldNow.pipe(Effect.repeat({ times: 500 }));
        const doneEarly = yield* Fiber.await(waiting).pipe(
          Effect.timeoutOption(Duration.millis(0)),
        );
        yield* TestClock.adjust(Duration.seconds(2));
        yield* Fiber.join(waiting);
        assert.isTrue(
          doneEarly._tag === "Some",
          `the turn for m-int waited the full 15 s; pair lifecycle=${(yield* h.pair()).lifecycle} (pairing never applied)`,
        );
      }),
    );
  });

  describe("S2 exactly-once is in memory only", () => {
    it.effect(
      "on, then off, then a restart and a retried 'on' command must not turn Helix back on",
      () =>
        Effect.gen(function* () {
          const h = yield* setup();
          const p = yield* h.pair();
          yield* h.coordinator.service.disable({ pairId: p.id, expectedRevision: p.revision });
          yield* (yield* h.coordinator.hooks.interceptClientCommand(msg(h.leadId, "m1", on)))
            .afterAccepted;
          assert.equal((yield* h.pair()).lifecycle, "active");
          yield* (yield* h.coordinator.hooks.interceptClientCommand(msg(h.leadId, "m2", off)))
            .afterAccepted;
          assert.equal((yield* h.pair()).lifecycle, "disabled");
          const restarted = yield* h.restart();
          // The same command id re-sent after reconnect: the engine replays it as accepted.
          yield* (yield* restarted.hooks.interceptClientCommand(msg(h.leadId, "m1", on)))
            .afterAccepted;
          assert.equal(
            (yield* h.pair()).lifecycle,
            "disabled",
            "a stale retried message re-enabled Helix after the user turned it off",
          );
        }),
    );
  });
});
