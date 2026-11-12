/**
 * Regression tests adopted from the second review pass (Q1–Q6). Q5 follows the
 * decision that a Builder stays a Builder while its pair row exists: after
 * disable it can be deleted, but it still runs no server turn.
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
import { Effect, Exit, Layer, Ref, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HelixRepositoryLive } from "../persistence/Layers/HelixRepository.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  HelixRepository,
  HelixRepositoryError,
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
    const deps = {
      repository,
      runtime: fake.shape,
      isEnabled: Ref.get(enabled),
      setRoleProfile: () => {},
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
    return { fake, coordinator, pair, latest, lead, builder, restart, leadId, builderId, base };
  });

const layer = it.layer(HelixRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const turnStartsTo = (fake: Fake, threadId: string) => fake.starts(threadId).length;

layer("Helix review round 2 regressions", (it) => {
  describe("Q1 wake after an in-turn review", () => {
    it.effect("a wake refused because the Lead already reviewed does not loop", () =>
      Effect.gen(function* () {
        const h = yield* setup();
        yield* h.coordinator.port.delegate(h.lead, { requestId: "a", brief, waitSeconds: 0 });
        const handoff = yield* h.latest();
        h.fake.settle(h.builderId, handoff.dispatch!.messageId, "t1", "completed");
        yield* h.coordinator.hooks.sweep();
        assert.equal((yield* h.latest()).delivery, "wake_dispatched");
        // The Lead (still in its turn) reviews before its queued wake is promoted.
        yield* h.coordinator.port.review(h.lead, {
          handoffId: handoff.id,
          requestId: "rv",
          verdict: "accepted",
        });
        for (let i = 0; i < 4; i += 1) {
          const current = yield* h.latest();
          if (current.wake) {
            // The queued wake is promoted; the reactor asks the coordinator.
            yield* h.coordinator.hooks.admitAutomaticTurn({
              threadId: ThreadId.makeUnsafe(h.leadId),
              messageId: current.wake.messageId,
              dispatchOrigin: "agent",
            });
          }
          yield* h.coordinator.hooks.sweep();
        }
        const after = yield* h.latest();
        assert.equal(
          turnStartsTo(h.fake, h.leadId),
          1,
          `lead turn starts=${turnStartsTo(h.fake, h.leadId)} delivery=${after.delivery} wakeAttempts=${after.wakeAttempts}`,
        );
      }),
    );
  });

  describe("Q2 Helix stop fails while the user's interrupt goes through", () => {
    it.effect("the in-flight brief is still gated (fail closed) and the Builder interrupted", () =>
      Effect.gen(function* () {
        let failCommits = false;
        const h = yield* setup({
          repository: (r) => ({
            ...r,
            commit: (input) =>
              failCommits
                ? Effect.fail(new HelixRepositoryError({ code: "storage", message: "busy" }))
                : r.commit(input),
          }),
        });
        yield* h.coordinator.port.delegate(h.lead, { requestId: "a", brief, waitSeconds: 0 });
        const handoff = yield* h.latest();
        failCommits = true;
        const intercepted = yield* Effect.exit(
          h.coordinator.hooks.interceptClientCommand({
            type: "thread.turn.interrupt",
            commandId: "stop" as never,
            threadId: ThreadId.makeUnsafe(h.leadId),
            createdAt: NOW,
          }),
        );
        assert.isTrue(Exit.isSuccess(intercepted));
        const builderInterrupts = h.fake.commands.filter(
          (c) => c.type === "thread.turn.interrupt" && c.threadId === h.builderId,
        ).length;
        const stillSends = yield* h.coordinator.hooks.shouldSendServerTurn({
          threadId: ThreadId.makeUnsafe(h.builderId),
          messageId: handoff.dispatch!.messageId,
          dispatchOrigin: "agent",
        });
        assert.isTrue(
          builderInterrupts > 0 || !stillSends,
          `builderInterrupts=${builderInterrupts} briefStillAdmitted=${stillSends} hold=${(yield* h.pair()).hold?.kind ?? "none"}`,
        );
      }),
    );
  });

  describe("Q3 quarantined pair", () => {
    it.effect(
      "one bad pair row does not break listPairs for every pair, and the pair can be removed",
      () =>
        Effect.gen(function* () {
          const good = yield* setup();
          const bad = yield* setup();
          const badPair = yield* bad.pair();
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE helix_pairs SET config_json = '{"broken":true}' WHERE pair_id = ${badPair.id}`;
          const restarted = yield* bad.restart();
          const listed = yield* Effect.exit(restarted.service.listPairs());
          const del = yield* Effect.exit(
            restarted.hooks.interceptClientCommand({
              type: "thread.delete",
              commandId: "del" as never,
              threadId: ThreadId.makeUnsafe(bad.builderId),
            }),
          );
          yield* restarted.hooks.onDomainEvent({
            type: "thread.deleted",
            sequence: 9,
            payload: { threadId: bad.leadId },
          } as unknown as OrchestrationEvent);
          const stillThere = restarted.hooks.roleOf(bad.builderId);
          const goodPair = yield* good.pair();
          assert.isTrue(
            Exit.isSuccess(listed) && (stillThere === null || Exit.isSuccess(del)),
            `listPairs=${Exit.isSuccess(listed) ? "ok" : "FAILED"} builderDelete=${Exit.isSuccess(del) ? "ok" : "refused"} builderRoleAfterLeadDelete=${stillThere ? "kept" : "gone"} (good pair ${goodPair.id} unaffected in storage)`,
          );
        }),
    );
  });

  describe("Q4 Pause lets the current Builder turn continue", () => {
    it.effect("an admitted, running brief is still sendable after Pause", () =>
      Effect.gen(function* () {
        const h = yield* setup();
        yield* h.coordinator.port.delegate(h.lead, { requestId: "a", brief, waitSeconds: 0 });
        const handoff = yield* h.latest();
        const pair = yield* h.pair();
        yield* h.coordinator.service.pause({ pairId: pair.id, expectedRevision: pair.revision });
        const sendable = yield* h.coordinator.hooks.shouldSendServerTurn({
          threadId: ThreadId.makeUnsafe(h.builderId),
          messageId: handoff.dispatch!.messageId,
          dispatchOrigin: "agent",
        });
        assert.isTrue(
          sendable,
          "pre-send/post-bind gate refuses (and post-bind interrupts) the running brief under Pause",
        );
      }),
    );
  });

  describe("Q5 former Builder after disable", () => {
    it.effect("after disable the Builder can be deleted, and still runs no server turn", () =>
      Effect.gen(function* () {
        const h = yield* setup();
        h.fake.threads.set(h.builderId, shell(h.builderId));
        const pair = yield* h.pair();
        yield* h.coordinator.service.disable({ pairId: pair.id, expectedRevision: pair.revision });
        const del = yield* Effect.exit(
          h.coordinator.hooks.interceptClientCommand({
            type: "thread.delete",
            commandId: "del" as never,
            threadId: ThreadId.makeUnsafe(h.builderId),
          }),
        );
        const goal = yield* h.coordinator.hooks.shouldSendServerTurn({
          threadId: ThreadId.makeUnsafe(h.builderId),
          messageId: "goal-continuation:x",
        });
        const user = yield* h.coordinator.hooks.shouldSendServerTurn({
          threadId: ThreadId.makeUnsafe(h.builderId),
          messageId: "m1",
          dispatchOrigin: "user",
        });
        assert.isTrue(Exit.isSuccess(del), "a disabled pair's Builder can be deleted");
        // Never an ordinary chat while its pair row exists.
        assert.isFalse(goal);
        assert.isFalse(user);
      }),
    );
  });

  describe("Q6 Stop frees a running handoff left by a restart", () => {
    it.effect("restart hold + running handoff: Stop interrupts and frees the slot", () =>
      Effect.gen(function* () {
        const h = yield* setup();
        yield* h.coordinator.port.delegate(h.lead, { requestId: "a", brief, waitSeconds: 0 });
        const handoff = yield* h.latest();
        h.fake.settle(h.builderId, handoff.dispatch!.messageId, "t1", "running");
        const restarted = yield* h.restart();
        assert.equal((yield* h.pair()).hold?.kind, "restart");
        assert.equal((yield* h.latest()).state, "running");
        h.fake.threads.set(h.builderId, shell(h.builderId));
        yield* restarted.service.stop({ pairId: (yield* h.pair()).id });
        assert.equal((yield* h.latest()).state, "interrupted");
        assert.isAbove(
          h.fake.commands.filter(
            (c) => c.type === "thread.turn.interrupt" && c.threadId === h.builderId,
          ).length,
          0,
        );
      }),
    );
  });
});
