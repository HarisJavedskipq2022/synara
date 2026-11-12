/**
 * Regression tests from the independent review of the Helix coordinator
 * (P1-P7). Each asserts the correct behaviour for a defect the review found.
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

layer("Helix review regressions", (it) => {
  describe("P1 Stop while the Builder turn is still starting", () => {
    it.effect("interrupts the Builder even before it has an active turn id", () =>
      Effect.gen(function* () {
        const h = yield* setup();
        yield* h.coordinator.port.delegate(h.lead, { requestId: "a", brief, waitSeconds: 0 });
        assert.equal((yield* h.latest()).state, "running");
        // PCR already passed admitAutomaticTurn and is starting the provider session.
        h.fake.threads.set(
          h.builderId,
          shell(h.builderId, {
            session: {
              threadId: ThreadId.makeUnsafe(h.builderId),
              status: "starting",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: NOW,
            } as OrchestrationThreadShell["session"],
          }),
        );
        yield* h.coordinator.hooks.interceptClientCommand({
          type: "thread.turn.interrupt",
          commandId: "stop" as never,
          threadId: ThreadId.makeUnsafe(h.leadId),
          createdAt: NOW,
        });
        assert.equal((yield* h.pair()).hold?.kind, "stop");
        const builderInterrupts = h.fake.commands.filter(
          (c) => c.type === "thread.turn.interrupt" && c.threadId === h.builderId,
        );
        assert.lengthOf(builderInterrupts, 1, "Builder was not interrupted");
      }),
    );
  });

  describe("P2 restart before the Builder's completion was ingested", () => {
    it.effect("finalises the completed turn as a deliverable result, not a lateResult", () =>
      Effect.gen(function* () {
        const h = yield* setup();
        yield* h.coordinator.port.delegate(h.lead, { requestId: "a", brief, waitSeconds: 0 });
        const handoff = yield* h.latest();
        yield* h.coordinator.port.report(h.builder("t1"), {
          outcome: "completed",
          summary: "done",
        });
        // Provider journal has the completion; projections not yet ingested at boot.
        h.fake.settle(h.builderId, handoff.dispatch!.messageId, "t1", "running");
        const restarted = yield* h.restart();
        // Ingestion catches up after the coordinator was built.
        h.fake.settle(h.builderId, handoff.dispatch!.messageId, "t1", "completed");
        yield* restarted.hooks.onDomainEvent({
          type: "thread.turn-diff-completed",
          sequence: 5,
          payload: { threadId: h.builderId },
        } as unknown as OrchestrationEvent);
        const after = yield* h.latest();
        assert.equal(
          after.state,
          "awaiting_review",
          `state=${after.state} lateResult=${after.lateResult?.summary}`,
        );
      }),
    );
  });

  describe("P3 Builder creation refused once", () => {
    it.effect("does not leave a prepared handoff occupying the slot with no hold", () =>
      Effect.gen(function* () {
        const fake = new Fake();
        fake.rejectTypes.add("thread.create");
        const h = yield* setup({ fake });
        yield* h.coordinator.port.delegate(h.lead, { requestId: "a", brief, waitSeconds: 0 });
        fake.rejectTypes.clear();
        yield* h.coordinator.hooks.sweep();
        const stuck = yield* h.latest();
        const pair = yield* h.pair();
        const second = yield* Effect.exit(
          h.coordinator.port.delegate(h.lead, { requestId: "b", brief, waitSeconds: 0 }),
        );
        assert.isTrue(
          stuck.state !== "prepared" || pair.hold !== null || Exit.isSuccess(second),
          `state=${stuck.state} hold=${pair.hold?.kind ?? "none"} second=${Exit.isFailure(second) ? "refused" : "ok"}`,
        );
      }),
    );
  });

  describe("P4 report from another Builder turn", () => {
    it.effect("a report from turn t-old does not bind to the next handoff and wedge it", () =>
      Effect.gen(function* () {
        const h = yield* setup();
        yield* h.coordinator.port.delegate(h.lead, { requestId: "a", brief, waitSeconds: 0 });
        const h2 = yield* h.latest();
        assert.isNull(h2.builderTurnId);
        // A turn other than the brief's (e.g. a stopped turn still finishing) reports.
        yield* h.coordinator.port.report(h.builder("t-old"), {
          outcome: "completed",
          summary: "stale report from another turn",
        });
        h.fake.settle(h.builderId, h2.dispatch!.messageId, "t-new", "completed");
        yield* h.coordinator.hooks.sweep();
        yield* h.coordinator.hooks.sweep();
        const after = yield* h.latest();
        assert.equal(
          after.state,
          "awaiting_review",
          `state=${after.state} turn=${after.builderTurnId}`,
        );
        assert.notEqual(after.result?.summary, "stale report from another turn");
      }),
    );
  });

  describe("P5 Builder permissions follow the Lead", () => {
    it.effect("a Lead lowered to approval-required does not keep a full-access Builder", () =>
      Effect.gen(function* () {
        const h = yield* setup({ leadRuntimeMode: "full-access" });
        const lead = h.fake.threads.get(h.leadId)!;
        h.fake.threads.set(h.leadId, { ...lead, runtimeMode: "approval-required" });
        yield* h.coordinator.port.delegate(h.lead, { requestId: "a", brief, waitSeconds: 0 });
        const start = h.fake.starts(h.builderId)[0];
        assert.equal(
          start?.type === "thread.turn.start" ? start.runtimeMode : null,
          "approval-required",
        );
      }),
    );
  });

  describe("P6 a Helix storage failure blocks the user's own Stop", () => {
    it.effect("the user's interrupt of the Lead is not refused when Helix cannot commit", () =>
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
        failCommits = true;
        const exit = yield* Effect.exit(
          h.coordinator.hooks.interceptClientCommand({
            type: "thread.turn.interrupt",
            commandId: "stop" as never,
            threadId: ThreadId.makeUnsafe(h.leadId),
            createdAt: NOW,
          }),
        );
        assert.isTrue(Exit.isSuccess(exit), "interceptClientCommand refused the user's Stop");
      }),
    );
  });

  describe("P7 duplicate delivery", () => {
    it.effect("helix_wait does not hand back a result that was already sent as a wake", () =>
      Effect.gen(function* () {
        const h = yield* setup();
        yield* h.coordinator.port.delegate(h.lead, { requestId: "a", brief, waitSeconds: 0 });
        const handoff = yield* h.latest();
        h.fake.settle(h.builderId, handoff.dispatch!.messageId, "t1", "completed");
        yield* h.coordinator.hooks.sweep();
        assert.equal((yield* h.latest()).delivery, "wake_dispatched");
        assert.lengthOf(h.fake.starts(h.leadId), 1);
        const waited = yield* h.coordinator.port.wait(h.lead, {
          handoffId: handoff.id,
          waitSeconds: 5,
        });
        assert.isTrue(
          waited.timedOut || waited.handoff.result === null,
          "result returned in tool AND as wake",
        );
      }),
    );
  });
});
