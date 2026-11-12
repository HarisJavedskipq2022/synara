/**
 * Regression tests adopted from the third review pass (R1–R4): wakes with the
 * setting off, Resume after the wake cap, and former Builders keeping no
 * capabilities after their pair is removed or their thread deleted.
 */
import {
  ModelSelection,
  ProjectId,
  ThreadId,
  TurnId,
  type HelixBriefInput,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Ref, Schema } from "effect";

import { HelixRepositoryLive } from "../persistence/Layers/HelixRepository.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  HelixRepository,
  type HelixRepositoryShape,
} from "../persistence/Services/HelixRepository.ts";
import { makeHelixCoordinator } from "./coordinator.ts";
import { makeAgentGatewaySessionRegistry } from "../agentGateway/Layers/AgentGatewaySessionRegistry.ts";
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
const brief: HelixBriefInput = { title: "T", objective: "O", acceptanceCriteria: "A" };

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

const userTurn = (leadId: string, messageId: string): OrchestrationCommand =>
  ({
    type: "thread.turn.start",
    commandId: `user-${messageId}` as never,
    threadId: ThreadId.makeUnsafe(leadId),
    message: { messageId: messageId as never, role: "user", text: "hi", attachments: [] },
    dispatchMode: "queue",
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: NOW,
  }) as OrchestrationCommand;

layer("Helix review round 3 regressions", (it) => {
  describe("R1 setting off: wakes the reactor will refuse are still sent", () => {
    it.effect(
      "a result finishing with the setting off, then user messages, append no wake turns",
      () =>
        Effect.gen(function* () {
          const h = yield* setup();
          yield* h.coordinator.port.delegate(h.lead, { requestId: "a", brief, waitSeconds: 0 });
          const handoff = yield* h.latest();
          yield* Ref.set(h.enabled, false);
          h.fake.settle(h.builderId, handoff.dispatch!.messageId, "t1", "completed");
          yield* h.coordinator.hooks.onDomainEvent({
            type: "thread.turn-diff-completed",
            sequence: 3,
            payload: { threadId: h.builderId },
          } as unknown as OrchestrationEvent);
          for (let i = 0; i < 3; i += 1) {
            const current = yield* h.latest();
            if (current.wake && current.delivery !== "pending") {
              yield* h.coordinator.hooks.admitAutomaticTurn({
                threadId: ThreadId.makeUnsafe(h.leadId),
                messageId: current.wake.messageId,
                dispatchOrigin: "agent",
              });
            }
            const intercepted = yield* h.coordinator.hooks.interceptClientCommand(
              userTurn(h.leadId, `m-${i}`),
            );
            yield* intercepted.afterAccepted;
          }
          const after = yield* h.latest();
          assert.equal(
            h.fake.starts(h.leadId).length,
            0,
            `lead wake turns appended=${h.fake.starts(h.leadId).length} delivery=${after.delivery} wakeAttempts=${after.wakeAttempts}`,
          );
        }),
    );
  });

  describe("R2 wake cap and Resume", () => {
    it.effect("after the wake cap, Resume releases the hold", () =>
      Effect.gen(function* () {
        const h = yield* setup();
        yield* h.coordinator.port.delegate(h.lead, { requestId: "a", brief, waitSeconds: 0 });
        const handoff = yield* h.latest();
        h.fake.settle(h.builderId, handoff.dispatch!.messageId, "t1", "completed");
        yield* h.coordinator.hooks.sweep();
        for (let i = 0; i < 7; i += 1) {
          const p = yield* h.pair();
          if (p.hold === null) {
            yield* h.coordinator.service.pause({ pairId: p.id, expectedRevision: p.revision });
          }
          const current = yield* h.latest();
          if (current.wake) {
            yield* h.coordinator.hooks.admitAutomaticTurn({
              threadId: ThreadId.makeUnsafe(h.leadId),
              messageId: current.wake.messageId,
              dispatchOrigin: "agent",
            });
          }
          const held = yield* h.pair();
          if (held.hold !== null) {
            yield* Effect.exit(
              h.coordinator.service.resume({ pairId: held.id, expectedRevision: held.revision }),
            );
          }
        }
        const final = yield* h.pair();
        if (final.hold !== null) {
          yield* Effect.exit(
            h.coordinator.service.resume({ pairId: final.id, expectedRevision: final.revision }),
          );
        }
        const afterResume = yield* h.pair();
        const last = yield* h.latest();
        assert.isNull(
          afterResume.hold,
          `hold after Resume=${afterResume.hold?.kind} reason=${afterResume.hold?.reason} wakeAttempts=${last.wakeAttempts} delivery=${last.delivery} leadWakes=${h.fake.starts(h.leadId).length}`,
        );
      }),
    );
  });

  describe("R3 removePair on an active pair with a running Builder", () => {
    it.effect("the Builder's live credential does not gain base capabilities", () =>
      Effect.gen(function* () {
        const h = yield* setup();
        h.fake.threads.set(h.builderId, shell(h.builderId));
        yield* h.coordinator.port.delegate(h.lead, { requestId: "a", brief, waitSeconds: 0 });
        assert.equal((yield* h.latest()).state, "running");
        // The same registry semantics the live gateway uses.
        const registry = makeAgentGatewaySessionRegistry();
        const issued = registry.issue(ThreadId.makeUnsafe(h.builderId), "codex");
        const profile = h.profiles.get(h.builderId) as never;
        registry.setThreadRoleProfile(h.builderId, profile);
        const before = [...(registry.verify(issued.token)?.capabilities ?? [])];
        yield* h.coordinator.service.removePair({ pairId: (yield* h.pair()).id } as never);
        registry.setThreadRoleProfile(h.builderId, (h.profiles.get(h.builderId) ?? null) as never);
        const after = [...(registry.verify(issued.token)?.capabilities ?? [])];
        assert.deepStrictEqual(
          after.filter((c) => c !== "helix:builder"),
          [],
          `before=${before.join(",")} after removePair=${after.join(",")} builderArchived=${h.fake.commands.some((c) => c.type === "thread.archive")} stopCommitted=${h.fake.commands.some((c) => c.type === "thread.turn.interrupt")}`,
        );
      }),
    );
  });

  describe("R4 deleting a disabled pair's Builder while its session lives", () => {
    it.effect("the old Builder credential stays restricted until its session is gone", () =>
      Effect.gen(function* () {
        const h = yield* setup();
        h.fake.threads.set(h.builderId, shell(h.builderId));
        const p = yield* h.pair();
        yield* h.coordinator.service.disable({ pairId: p.id, expectedRevision: p.revision });
        const registry = makeAgentGatewaySessionRegistry();
        const issued = registry.issue(ThreadId.makeUnsafe(h.builderId), "codex");
        registry.setThreadRoleProfile(h.builderId, h.profiles.get(h.builderId) as never);
        yield* h.coordinator.hooks.onDomainEvent({
          type: "thread.deleted",
          sequence: 7,
          payload: { threadId: h.builderId },
        } as unknown as OrchestrationEvent);
        registry.setThreadRoleProfile(h.builderId, (h.profiles.get(h.builderId) ?? null) as never);
        const after = [...(registry.verify(issued.token)?.capabilities ?? [])];
        const replaced = (yield* h.pair()).builderThreadId;
        assert.deepStrictEqual(
          after.filter((c) => c !== "helix:builder"),
          [],
          `old Builder credential after deletion=${after.join(",")} newBuilderId=${replaced}`,
        );
      }),
    );
  });
});
