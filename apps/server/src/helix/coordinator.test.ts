import {
  ModelSelection,
  ProjectId,
  ThreadId,
  TurnId,
  type HelixBriefInput,
  type HelixHandoff,
  type HelixPair,
  type HelixStreamEvent,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Ref, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { AgentGatewayRoleProfile } from "../agentGateway/Services/AgentGatewaySessionRegistry.ts";
import { GatewayToolError } from "../agentGateway/toolRuntime.ts";
import { HelixRepositoryLive } from "../persistence/Layers/HelixRepository.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  HelixRepository,
  HelixRepositoryError,
  type HelixRepositoryShape,
} from "../persistence/Services/HelixRepository.ts";
import { makeHelixCoordinator, type HelixCoordinator } from "./coordinator.ts";
import { HELIX_ROLE_PROMPT_VERSION } from "./rolePrompts.ts";
import { helixDispatchCommandId, helixRequestFingerprint, helixWakeCommandId } from "./identity.ts";
import { helixBriefMessageId, helixWakeMessageId } from "./messages.ts";
import {
  HelixRuntimeError,
  type HelixDeliveryObservation,
  type HelixRuntimeShape,
  type HelixTurnObservation,
} from "./runtime.ts";
import type { HelixToolCaller } from "./Services/HelixGatewayPort.ts";
import { HELIX_MAX_WAKE_ATTEMPTS, transitionHelix, type HelixCommand } from "./stateMachine.ts";

const NOW = "2026-11-12T10:00:00.000Z";
const PROJECT = ProjectId.makeUnsafe("project");
const codex = Schema.decodeSync(ModelSelection)({ provider: "codex", model: "gpt-5" });
const claude = Schema.decodeSync(ModelSelection)({ provider: "claudeAgent", model: "sonnet" });
const brief: HelixBriefInput = {
  title: "Login form",
  objective: "Add the login form.",
  acceptanceCriteria: "It validates.",
};

function shell(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: PROJECT,
    title: `Thread ${id}`,
    modelSelection: claude,
    runtimeMode: "approval-required",
    interactionMode: "default",
    envMode: "worktree",
    branch: "feature/login",
    worktreePath: "/tmp/worktrees/login",
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
    ...overrides,
  } as OrchestrationThreadShell;
}

/** A fake engine: records commands, replays identical command ids, and lets tests script turns. */
class FakeRuntime {
  readonly threads = new Map<string, OrchestrationThreadShell>();
  readonly commands: OrchestrationCommand[] = [];
  readonly accepted = new Set<string>();
  readonly turns = new Map<string, HelixTurnObservation>();
  readonly completedRuns = new Set<string>();
  readonly unsettled = new Set<string>();
  readonly finalTexts = new Map<string, string>();
  readonly deliveries = new Map<string, HelixDeliveryObservation>();
  /** Commands of these types fail as a storage error (the engine outcome is unknown). */
  readonly unknownOutcomeTypes = new Set<string>();
  readonly rejectTypes = new Set<string>();
  /** When set, `thread.turn.start` dispatches wait on it (an engine that is slow to answer). */
  turnStartGate: Deferred.Deferred<void> | null = null;

  turnStarts(threadId: string) {
    return this.commands.filter(
      (command) => command.type === "thread.turn.start" && command.threadId === threadId,
    );
  }

  /** Script the Builder turn a brief started. */
  settleTurn(
    threadId: string,
    messageId: string,
    turnId: string,
    state: HelixTurnObservation["state"] = "completed",
    text = "Done.",
  ) {
    this.turns.set(`${threadId}|${messageId}`, { turnId: TurnId.makeUnsafe(turnId), state });
    if (state === "completed") this.completedRuns.add(turnId);
    this.finalTexts.set(turnId, text);
  }

  readonly shape: HelixRuntimeShape = {
    dispatch: (command) => Effect.gen(this.dispatchGen.bind(this, command)),
    getThread: (threadId) =>
      this.failGetThread
        ? Effect.fail(new HelixRuntimeError({ message: "read failed", rejected: false }))
        : Effect.succeed(this.threads.get(threadId) ?? null),
    findTurnForMessage: (threadId, messageId) =>
      Effect.succeed(this.turns.get(`${threadId}|${messageId}`) ?? null),
    hasCompletedRun: (_threadId, turnId) => Effect.succeed(this.completedRuns.has(turnId)),
    isOutputSettled: (threadId) => Effect.succeed(!this.unsettled.has(threadId)),
    finalAssistantText: (_threadId, turnId) => Effect.succeed(this.finalTexts.get(turnId) ?? null),
    initialFailure: () => Effect.succeed(null),
    deliveryState: (threadId, messageId) =>
      Effect.succeed(this.deliveries.get(`${threadId}|${messageId}`) ?? "none"),
    commandAccepted: (commandId) => Effect.succeed(this.accepted.has(commandId)),
  };

  /** Projection reads fail (an unreadable thread). */
  failGetThread = false;
  /** Every dispatch attempt, including those that fail. */
  readonly attempted: OrchestrationCommand[] = [];

  private *dispatchGen(command: OrchestrationCommand) {
    this.attempted.push(command);
    if (command.type === "thread.turn.start" && this.turnStartGate !== null) {
      yield* Deferred.await(this.turnStartGate);
    }
    if (this.unknownOutcomeTypes.has(command.type)) {
      return yield* Effect.fail(
        new HelixRuntimeError({ message: "storage unavailable", rejected: false }),
      );
    }
    if (this.rejectTypes.has(command.type)) {
      return yield* Effect.fail(new HelixRuntimeError({ message: "refused", rejected: true }));
    }
    // Command receipts: an identical id is accepted once.
    if (this.accepted.has(command.commandId)) return { sequence: 0 };
    this.accepted.add(command.commandId);
    this.commands.push(command);
    if (command.type === "thread.create") {
      this.threads.set(
        command.threadId,
        shell(command.threadId, {
          title: command.title,
          modelSelection: command.modelSelection,
          envMode: command.envMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
        }),
      );
    }
    if (command.type === "thread.archive" || command.type === "thread.unarchive") {
      const thread = this.threads.get(command.threadId);
      if (thread)
        this.threads.set(command.threadId, {
          ...thread,
          archivedAt: command.type === "thread.archive" ? NOW : null,
        });
    }
    if (command.type === "thread.delete") this.threads.delete(command.threadId);
    return { sequence: this.commands.length };
  }
}

interface Harness {
  readonly runtime: FakeRuntime;
  readonly coordinator: HelixCoordinator;
  readonly repository: HelixRepositoryShape;
  readonly profiles: Map<string, AgentGatewayRoleProfile | null>;
  readonly enabled: Ref.Ref<boolean>;
  readonly pair: () => Effect.Effect<HelixPair>;
  readonly handoffs: () => Effect.Effect<ReadonlyArray<HelixHandoff>>;
  readonly lead: HelixToolCaller;
  readonly builder: (turnId?: string) => HelixToolCaller;
}

const layer = it.layer(HelixRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

let harnessCount = 0;

const makeHarness = (
  options: {
    readonly runtime?: FakeRuntime;
    readonly enabled?: boolean;
    readonly limits?: { maxCorrectionsPerWorkItem: number; maxDispatchesPerGoal: number };
    readonly hub?: boolean;
    readonly enable?: boolean;
    readonly leadId?: string;
  } = {},
) =>
  Effect.gen(function* () {
    harnessCount += 1;
    const leadId = options.leadId ?? `lead-${harnessCount}`;
    const builderId = `builder-${harnessCount}`;
    const runtime = options.runtime ?? new FakeRuntime();
    if (!runtime.threads.has(leadId)) runtime.threads.set(leadId, shell(leadId));
    const repository = yield* HelixRepository;
    const enabled = yield* Ref.make(options.enabled ?? true);
    const profiles = new Map<string, AgentGatewayRoleProfile | null>();
    const coordinator = yield* makeHelixCoordinator({
      repository,
      runtime: runtime.shape,
      isEnabled: Ref.get(enabled),
      setRoleProfile: (threadId, profile) => profiles.set(threadId, profile),
      isHubThread: () => Effect.succeed(options.hub === true),
      newThreadId: () => ThreadId.makeUnsafe(builderId),
    });
    if (options.enable !== false) {
      yield* coordinator.service.enable({
        leadThreadId: ThreadId.makeUnsafe(leadId),
        builderModelSelection: codex,
        ...(options.limits ? { limits: options.limits } : {}),
      });
    }
    const pairFor = () =>
      repository.getPairByLeadThread(ThreadId.makeUnsafe(leadId)).pipe(
        Effect.orDie,
        Effect.map((pair) => pair!),
      );
    const harness: Harness = {
      runtime,
      coordinator,
      repository,
      profiles,
      enabled,
      pair: pairFor,
      handoffs: () =>
        pairFor().pipe(
          Effect.flatMap((pair) => repository.listHandoffs(pair.id)),
          Effect.orDie,
        ),
      lead: {
        threadId: ThreadId.makeUnsafe(leadId),
        turnId: TurnId.makeUnsafe(`lead-turn-${harnessCount}`),
        sessionKey: "lead-session",
        provider: "claudeAgent",
        role: "lead",
      },
      builder: (turnId) => ({
        threadId: ThreadId.makeUnsafe(builderId),
        turnId: turnId === undefined ? null : TurnId.makeUnsafe(turnId),
        sessionKey: "builder-session",
        provider: "codex",
        role: "builder",
      }),
    };
    return harness;
  });

const flip = <A, E>(effect: Effect.Effect<A, E>) => Effect.flip(effect);

/** Let forked work (tool calls, detached effect fibers) run to their next suspension. */
const drain = Effect.yieldNow.pipe(Effect.repeat({ times: 100 }));

const delegate = (h: Harness, requestId = "first", waitSeconds = 0, input = brief) =>
  h.coordinator.port.delegate(h.lead, { requestId, brief: input, waitSeconds });

/** Complete the Builder turn of the latest dispatched brief and let the coordinator observe it. */
const completeLatestBrief = (h: Harness, turnId: string, text = "Done.") =>
  Effect.gen(function* () {
    const pair = yield* h.pair();
    const starts = h.runtime.turnStarts(pair.builderThreadId);
    const last = starts.at(-1);
    if (last?.type !== "thread.turn.start") return yield* Effect.die("no brief dispatched");
    h.runtime.settleTurn(pair.builderThreadId, last.message.messageId, turnId, "completed", text);
    yield* h.coordinator.hooks.sweep();
  });

const on = (selection: ModelSelection = codex) => ({
  enabled: true,
  builderModelSelection: selection,
});

const latest = (h: Harness) => h.handoffs().pipe(Effect.map((handoffs) => handoffs[0]!));

layer("Helix coordinator", (it) => {
  describe("full loop", () => {
    it.effect(
      "delegate → Builder turn → report → in-tool result → changes_requested → same Builder → wake → accepted",
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const pair = yield* h.pair();
          // Roles are applied before the Builder thread exists.
          assert.deepStrictEqual(h.profiles.get(pair.builderThreadId), {
            kind: "helix_builder",
            pairId: pair.id,
          });
          assert.deepStrictEqual(h.profiles.get(pair.leadThreadId), {
            kind: "helix_lead",
            pairId: pair.id,
          });
          assert.isFalse(h.runtime.threads.has(pair.builderThreadId));

          const waiting = yield* h.coordinator.port
            .delegate(h.lead, { requestId: "first", brief, waitSeconds: 30 })
            .pipe(Effect.forkChild);
          yield* drain;

          // Lazy Builder creation in the Lead's worktree, linked only through Helix.
          const create = h.runtime.commands.find((command) => command.type === "thread.create");
          assert.equal(create?.type, "thread.create");
          if (create?.type === "thread.create") {
            assert.equal(create.threadId, pair.builderThreadId);
            assert.equal(create.worktreePath, "/tmp/worktrees/login");
            assert.equal(create.branch, "feature/login");
            assert.equal(create.parentThreadId, null);
            assert.isUndefined(create.creationSource);
            assert.deepStrictEqual(create.modelSelection, codex);
          }
          const [firstBrief] = h.runtime.turnStarts(pair.builderThreadId);
          const first = (yield* h.handoffs())[0]!;
          assert.equal(firstBrief?.type, "thread.turn.start");
          if (firstBrief?.type === "thread.turn.start") {
            assert.equal(firstBrief.commandId, helixDispatchCommandId(first.id, 1));
            assert.equal(firstBrief.message.messageId, helixBriefMessageId(first.id, 1));
            assert.equal(firstBrief.dispatchOrigin, "agent");
            assert.equal(firstBrief.dispatchMode, "queue");
            assert.equal(firstBrief.createdAt, first.dispatch?.createdAt);
            assert.include(firstBrief.message.text, "Add the login form.");
          }
          assert.equal(first.state, "running");

          const report = yield* h.coordinator.port.report(h.builder("b-turn-1"), {
            outcome: "completed",
            summary: "Login form added",
            verification: "bun run test",
          });
          assert.equal(report.reportRevision, 1);
          yield* completeLatestBrief(h, "b-turn-1");

          const returned = yield* Fiber.join(waiting);
          assert.isFalse(returned.timedOut);
          assert.equal(returned.handoff.state, "awaiting_review");
          assert.equal(returned.handoff.delivery, "returned_in_tool");
          assert.equal(returned.handoff.result?.source, "report");
          assert.equal(returned.handoff.result?.summary, "Login form added");
          // In-tool delivery: no wake turn for the Lead.
          assert.lengthOf(h.runtime.turnStarts(pair.leadThreadId), 0);

          const review = yield* h.coordinator.port.review(h.lead, {
            handoffId: first.id,
            requestId: "review-1",
            verdict: "changes_requested",
            feedback: "Add the password field.",
            waitSeconds: 0,
          });
          assert.equal(review.verdict, "changes_requested");
          assert.isNotNull(review.next);
          const correction = (yield* h.handoffs())[0]!;
          assert.equal(correction.previousHandoffId, first.id);
          assert.equal(correction.correctionIndex, 1);
          assert.equal(correction.state, "running");
          // The same Builder thread; no second thread.
          assert.lengthOf(
            h.runtime.commands.filter((command) => command.type === "thread.create"),
            1,
          );
          const briefs = h.runtime.turnStarts(pair.builderThreadId);
          assert.lengthOf(briefs, 2);
          if (briefs[1]?.type === "thread.turn.start") {
            assert.include(briefs[1].message.text, "Add the password field.");
          }

          // Nobody waits now: the result wakes the Lead with a new turn, once.
          yield* completeLatestBrief(h, "b-turn-2", "Password field added.");
          const afterSettle = (yield* h.handoffs())[0]!;
          assert.equal(afterSettle.delivery, "wake_dispatched");
          assert.equal(afterSettle.result?.outcome, "partial");
          assert.equal(afterSettle.result?.source, "final_message");
          const wakes = h.runtime.turnStarts(pair.leadThreadId);
          assert.lengthOf(wakes, 1);
          if (wakes[0]?.type === "thread.turn.start") {
            assert.equal(wakes[0].commandId, helixWakeCommandId(afterSettle.id, 1));
            assert.equal(wakes[0].message.messageId, helixWakeMessageId(afterSettle.id, 1));
            assert.equal(wakes[0].dispatchOrigin, "agent");
            assert.include(wakes[0].message.text, "Password field added.");
            assert.include(wakes[0].message.text, "untrusted");
          }
          yield* h.coordinator.hooks.sweep();
          assert.lengthOf(h.runtime.turnStarts(pair.leadThreadId), 1);
          // Waiting on the woken handoff does not present its result as new.
          const rewait = yield* h.coordinator.port.wait(h.lead, {
            handoffId: afterSettle.id,
            waitSeconds: 0,
          });
          assert.include(rewait.message, "Not a new result");
          assert.equal(rewait.handoff.delivery, "wake_dispatched");
          // The fresh in-tool delivery of the first handoff, read again, is also not new.
          const again = yield* h.coordinator.port.wait(h.lead, {
            handoffId: first.id,
            waitSeconds: 5,
          });
          assert.include(again.message, "Not a new result");

          const accepted = yield* h.coordinator.port.review(h.lead, {
            handoffId: afterSettle.id,
            requestId: "review-2",
            verdict: "accepted",
          });
          assert.isNull(accepted.next);
          assert.equal((yield* h.handoffs())[0]!.state, "accepted");
        }),
    );

    it.effect("makes requestId idempotent and refuses reuse with different content", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        const first = yield* delegate(h, "same");
        const replay = yield* delegate(h, "same");
        assert.isTrue(replay.replayed);
        assert.equal(replay.handoff.handoffId, first.handoff.handoffId);
        assert.lengthOf(h.runtime.turnStarts(pair.builderThreadId), 1);
        const conflict = yield* flip(
          delegate(h, "same", 0, { ...brief, objective: "Something else." }),
        );
        assert.equal((conflict as GatewayToolError).code, "helix_request_conflict");
        const busy = yield* flip(delegate(h, "other"));
        assert.equal((busy as GatewayToolError).code, "helix_handoff_active");
      }),
    );

    it.effect("times out the 30 s wait, keeps the Builder working, then wakes the Lead", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        const waiting = yield* h.coordinator.port
          .delegate(h.lead, { requestId: "slow", brief })
          .pipe(Effect.forkChild);
        yield* drain;
        yield* TestClock.adjust("30 seconds");
        const timedOut = yield* Fiber.join(waiting);
        assert.isTrue(timedOut.timedOut);
        assert.equal(timedOut.handoff.state, "running");
        assert.lengthOf(h.runtime.turnStarts(pair.leadThreadId), 0);
        yield* completeLatestBrief(h, "slow-turn");
        assert.lengthOf(h.runtime.turnStarts(pair.leadThreadId), 1);
        assert.equal((yield* latest(h)).delivery, "wake_dispatched");
      }),
    );
  });

  describe("Stop", () => {
    it.effect(
      "stops the pair from a user interrupt on the Lead, cancels waits, interrupts the Builder",
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const pair = yield* h.pair();
          const waiting = yield* h.coordinator.port
            .delegate(h.lead, { requestId: "x", brief, waitSeconds: 30 })
            .pipe(Effect.forkChild);
          yield* drain;
          // No turn is visible on the Builder yet (still starting): Helix interrupts it anyway.
          yield* h.coordinator.hooks.interceptClientCommand({
            type: "thread.turn.interrupt",
            commandId: "user-stop" as never,
            threadId: pair.leadThreadId,
            createdAt: NOW,
          });
          const stopped = yield* h.pair();
          assert.equal(stopped.cancellationEpoch, 1);
          assert.equal(stopped.hold?.kind, "stop");
          assert.equal((yield* latest(h)).state, "interrupted");
          const exit = yield* Fiber.await(waiting);
          assert.isTrue(Exit.isFailure(exit));
          // The user's own command interrupts the Lead; Helix interrupts the Builder.
          const interrupts = h.runtime.commands.filter(
            (command) => command.type === "thread.turn.interrupt",
          );
          assert.deepStrictEqual(
            interrupts.map((command) => command.threadId),
            [pair.builderThreadId],
          );

          // A server-queued brief promoted after Stop is suppressed.
          const handoff = yield* latest(h);
          assert.isFalse(
            yield* h.coordinator.hooks.admitAutomaticTurn({
              threadId: pair.builderThreadId,
              messageId: handoff.dispatch!.messageId,
            }),
          );

          // A late result is stored, never delivered, and does not restart anything.
          h.runtime.settleTurn(
            pair.builderThreadId,
            handoff.dispatch!.messageId,
            "late-turn",
            "completed",
            "Finished after Stop.",
          );
          yield* h.coordinator.hooks.onDomainEvent({
            type: "thread.turn-diff-completed",
            sequence: 99,
            payload: { threadId: pair.builderThreadId },
          } as unknown as OrchestrationEvent);
          const late = yield* latest(h);
          assert.equal(late.state, "interrupted");
          assert.equal(late.lateResult?.summary, "Finished after Stop.");
          assert.lengthOf(h.runtime.turnStarts(pair.leadThreadId), 0);
          assert.lengthOf(h.runtime.turnStarts(pair.builderThreadId), 1);

          // A user message to the Lead releases the hold and starts a new goal,
          // but only once the engine accepted it.
          const message = yield* h.coordinator.hooks.interceptClientCommand({
            type: "thread.turn.start",
            commandId: "user-msg" as never,
            threadId: pair.leadThreadId,
            message: {
              messageId: "m-1" as never,
              role: "user",
              text: "Try again",
              attachments: [],
            },
            dispatchMode: "queue",
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: NOW,
          } as OrchestrationCommand);
          assert.equal((yield* h.pair()).hold?.kind, "stop");
          yield* message.afterAccepted;
          const released = yield* h.pair();
          assert.isNull(released.hold);
          assert.equal(released.goal.seq, 1);
        }),
    );

    it.effect("suppresses a wake the server already queued before Stop", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        yield* delegate(h);
        yield* completeLatestBrief(h, "t1");
        const handoff = yield* latest(h);
        assert.equal(handoff.delivery, "wake_dispatched");
        assert.isTrue(
          yield* h.coordinator.hooks.admitAutomaticTurn({
            threadId: pair.leadThreadId,
            messageId: handoff.wake!.messageId,
          }),
        );
        yield* h.coordinator.service.stop({ pairId: pair.id });
        assert.isFalse(
          yield* h.coordinator.hooks.admitAutomaticTurn({
            threadId: pair.leadThreadId,
            messageId: handoff.wake!.messageId,
          }),
        );
        assert.equal((yield* latest(h)).delivery, "suppressed");
      }),
    );

    it.effect("Stop during dispatching (send outcome unknown) and at awaiting_review", () =>
      Effect.gen(function* () {
        const runtime = new FakeRuntime();
        runtime.unknownOutcomeTypes.add("thread.turn.start");
        const h = yield* makeHarness({ runtime });
        const pair = yield* h.pair();
        yield* delegate(h);
        assert.equal((yield* latest(h)).state, "dispatching");
        yield* h.coordinator.service.stop({ pairId: pair.id });
        assert.equal((yield* latest(h)).state, "interrupted");

        const h2 = yield* makeHarness();
        const pair2 = yield* h2.pair();
        yield* h2.coordinator.service.pause({ pairId: pair2.id, expectedRevision: pair2.revision });
        // Paused before anything runs: delegation is refused.
        const held = yield* flip(delegate(h2));
        assert.equal((held as GatewayToolError).code, "helix_pair_held");
        const paused = yield* h2.pair();
        yield* h2.coordinator.service.resume({
          pairId: pair2.id,
          expectedRevision: paused.revision,
        });
        yield* delegate(h2);
        const running = yield* h2.pair();
        yield* h2.coordinator.service.pause({
          pairId: pair2.id,
          expectedRevision: running.revision,
        });
        yield* completeLatestBrief(h2, "t2");
        // Under a hold the result waits; Stop then suppresses it.
        assert.equal((yield* latest(h2)).delivery, "pending");
        assert.lengthOf(h2.runtime.turnStarts(pair2.leadThreadId), 0);
        // A correction prepared under the hold is cancelled by Stop.
        yield* h2.coordinator.port.review(h2.lead, {
          handoffId: (yield* latest(h2)).id,
          requestId: "r",
          verdict: "changes_requested",
          feedback: "More.",
          waitSeconds: 0,
        });
        assert.equal((yield* latest(h2)).state, "prepared");
        yield* h2.coordinator.service.stop({ pairId: pair2.id });
        const handoffs = yield* h2.handoffs();
        assert.equal(handoffs[0]!.state, "cancelled");
        assert.lengthOf(h2.runtime.turnStarts(pair2.builderThreadId), 1);
      }),
    );
  });

  describe("limits, uncertainty and restart", () => {
    it.effect("pauses dispatch at the goal limit and dispatches after Resume", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          limits: { maxCorrectionsPerWorkItem: 3, maxDispatchesPerGoal: 1 },
        });
        const pair = yield* h.pair();
        yield* delegate(h, "one");
        yield* completeLatestBrief(h, "t1");
        yield* h.coordinator.port.review(h.lead, {
          handoffId: (yield* latest(h)).id,
          requestId: "ok",
          verdict: "accepted",
        });
        const capped = yield* delegate(h, "two");
        assert.equal(capped.handoff.state, "prepared");
        assert.equal(capped.hold?.kind, "limit");
        assert.lengthOf(h.runtime.turnStarts(pair.builderThreadId), 1);
        const held = yield* h.pair();
        yield* h.coordinator.service.resume({ pairId: pair.id, expectedRevision: held.revision });
        assert.lengthOf(h.runtime.turnStarts(pair.builderThreadId), 2);
      }),
    );

    it.effect("surfaces an uncertain send and never resends it", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        yield* delegate(h);
        const handoff = yield* latest(h);
        h.runtime.deliveries.set(
          `${pair.builderThreadId}|${handoff.dispatch!.messageId}`,
          "uncertain",
        );
        yield* h.coordinator.hooks.sweep();
        assert.equal((yield* latest(h)).state, "uncertain");
        const held = yield* h.pair();
        assert.equal(held.hold?.kind, "uncertain");
        yield* h.coordinator.service.resume({ pairId: pair.id, expectedRevision: held.revision });
        yield* h.coordinator.hooks.sweep();
        assert.lengthOf(h.runtime.turnStarts(pair.builderThreadId), 1);
        assert.equal((yield* latest(h)).state, "uncertain");
      }),
    );

    /** Start a second coordinator over the same tables: a server restart. */
    const restart = (h: Harness) =>
      Effect.gen(function* () {
        const coordinator = yield* makeHelixCoordinator({
          repository: h.repository,
          runtime: h.runtime.shape,
          isEnabled: Effect.succeed(true),
          setRoleProfile: (threadId, profile) => h.profiles.set(threadId, profile),
        });
        yield* coordinator.hooks.reconcileStartup();
        return coordinator;
      });

    /** Write transitions straight to storage, as if the process died before the effects. */
    const commitOnly = (
      h: Harness,
      build: (handoffs: ReadonlyArray<HelixHandoff>) => HelixCommand,
    ) =>
      Effect.gen(function* () {
        const pair = yield* h.pair();
        const handoffs = yield* h.handoffs();
        const transition = transitionHelix({ pair, handoffs }, build(handoffs));
        if (!transition.ok) return yield* Effect.die(transition.error.message);
        if (!transition.changed) return;
        yield* h.repository
          .commit({
            pair: transition.pair,
            expectedRevision: transition.expectedRevision,
            handoffs: transition.writes,
          })
          .pipe(Effect.orDie);
      });

    const crashBrief = (h: Harness) =>
      commitOnly(h, () => ({
        type: "delegate",
        handoffId: `helix-handoff:crash-${harnessCount}` as never,
        requestId: "crash",
        fingerprint: helixRequestFingerprint({ kind: "delegate", brief }),
        brief,
        now: NOW,
      }));

    it.effect(
      "crash before dispatch persistence: held after restart, dispatched once on Resume",
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const pair = yield* h.pair();
          yield* crashBrief(h);
          const restarted = yield* restart(h);
          assert.equal((yield* h.pair()).hold?.kind, "restart");
          assert.equal((yield* latest(h)).state, "prepared");
          assert.lengthOf(h.runtime.turnStarts(pair.builderThreadId), 0);
          // Restart re-applied the role profiles from storage.
          assert.equal(h.profiles.get(pair.builderThreadId)?.kind, "helix_builder");
          yield* restarted.service.resume({
            pairId: pair.id,
            expectedRevision: (yield* h.pair()).revision,
          });
          assert.lengthOf(h.runtime.turnStarts(pair.builderThreadId), 1);
          yield* restarted.hooks.sweep();
          assert.lengthOf(h.runtime.turnStarts(pair.builderThreadId), 1);
        }),
    );

    it.effect(
      "crash after dispatch persistence, before the engine took it: resent as a new attempt once",
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const pair = yield* h.pair();
          yield* crashBrief(h);
          yield* commitOnly(h, () => ({ type: "builder.created", now: NOW }));
          h.runtime.threads.set(pair.builderThreadId, shell(pair.builderThreadId));
          yield* commitOnly(h, (handoffs) => ({
            type: "dispatch.start",
            handoffId: handoffs[0]!.id,
            messageId: helixBriefMessageId(handoffs[0]!.id, 1),
            now: NOW,
          }));
          const restarted = yield* restart(h);
          const handoff = yield* latest(h);
          assert.equal(handoff.state, "prepared");
          yield* restarted.service.resume({
            pairId: pair.id,
            expectedRevision: (yield* h.pair()).revision,
          });
          const briefs = h.runtime.turnStarts(pair.builderThreadId);
          assert.lengthOf(briefs, 1);
          assert.equal(briefs[0]?.commandId, helixDispatchCommandId(handoff.id, 2));
        }),
    );

    it.effect(
      "crash after the provider send, before acknowledgement: uncertain, never resent",
      () =>
        Effect.gen(function* () {
          const runtime = new FakeRuntime();
          runtime.unknownOutcomeTypes.add("thread.turn.start");
          const h = yield* makeHarness({ runtime });
          const pair = yield* h.pair();
          yield* delegate(h);
          const handoff = yield* latest(h);
          assert.equal(handoff.state, "dispatching");
          // The engine did take it and the provider send was in flight.
          runtime.accepted.add(handoff.dispatch!.commandId);
          runtime.deliveries.set(
            `${pair.builderThreadId}|${handoff.dispatch!.messageId}`,
            "inflight",
          );
          runtime.unknownOutcomeTypes.clear();
          const restarted = yield* restart(h);
          assert.equal((yield* latest(h)).state, "uncertain");
          assert.equal((yield* h.pair()).hold?.kind, "uncertain");
          yield* restarted.service.resume({
            pairId: pair.id,
            expectedRevision: (yield* h.pair()).revision,
          });
          assert.lengthOf(runtime.turnStarts(pair.builderThreadId), 0);
        }),
    );

    it.effect(
      "crash after Builder completion, before Lead delivery: delivered exactly once after Resume",
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const pair = yield* h.pair();
          yield* delegate(h);
          const handoff = yield* latest(h);
          // The turn finished, but the process died before the coordinator saw it.
          h.runtime.settleTurn(pair.builderThreadId, handoff.dispatch!.messageId, "t-done");
          const restarted = yield* restart(h);
          const after = yield* latest(h);
          assert.equal(after.state, "awaiting_review");
          assert.equal(after.delivery, "pending");
          assert.equal((yield* h.pair()).hold?.kind, "restart");
          assert.lengthOf(h.runtime.turnStarts(pair.leadThreadId), 0);
          yield* restarted.service.resume({
            pairId: pair.id,
            expectedRevision: (yield* h.pair()).revision,
          });
          yield* restarted.hooks.sweep();
          yield* restart(h);
          assert.lengthOf(h.runtime.turnStarts(pair.leadThreadId), 1);
        }),
    );

    it.effect("crash during Stop: still stopped after restart and nothing runs", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        yield* delegate(h);
        yield* commitOnly(h, () => ({ type: "stop", now: NOW }));
        yield* restart(h);
        const stopped = yield* h.pair();
        assert.equal(stopped.hold?.kind, "stop");
        assert.equal((yield* latest(h)).state, "interrupted");
        assert.lengthOf(h.runtime.turnStarts(pair.builderThreadId), 1);
        assert.lengthOf(h.runtime.turnStarts(pair.leadThreadId), 0);
      }),
    );

    it.effect(
      "a wake requested before a crash is resolved from the command ledger, never sent twice",
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const pair = yield* h.pair();
          yield* delegate(h);
          yield* completeLatestBrief(h, "t1");
          assert.lengthOf(h.runtime.turnStarts(pair.leadThreadId), 1);
          yield* restart(h);
          assert.equal((yield* latest(h)).delivery, "wake_dispatched");
          assert.lengthOf(h.runtime.turnStarts(pair.leadThreadId), 1);
        }),
    );
  });

  describe("guards, lifecycle and session roles", () => {
    it.effect("refuses Builder misuse and keeps the Builder's workspace fixed", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        const refusal = (command: OrchestrationCommand) =>
          h.coordinator.hooks.interceptClientCommand(command).pipe(
            Effect.flip,
            Effect.map((error) => error.code),
          );
        assert.equal(
          yield* refusal({
            type: "thread.turn.start",
            commandId: "c" as never,
            threadId: pair.builderThreadId,
            message: { messageId: "m" as never, role: "user", text: "hi", attachments: [] },
            dispatchMode: "queue",
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt: NOW,
          } as OrchestrationCommand),
          "HELIX_UNSUPPORTED_THREAD",
        );
        assert.equal(
          yield* refusal({
            type: "thread.archive",
            commandId: "c" as never,
            threadId: pair.builderThreadId,
          }),
          "HELIX_UNSUPPORTED_THREAD",
        );
        assert.equal(
          yield* refusal({
            type: "thread.delete",
            commandId: "c" as never,
            threadId: pair.builderThreadId,
          }),
          "HELIX_UNSUPPORTED_THREAD",
        );
        assert.equal(
          yield* refusal({
            type: "thread.meta.update",
            commandId: "c" as never,
            threadId: pair.builderThreadId,
            branch: "other",
          }),
          "HELIX_UNSUPPORTED_THREAD",
        );
        // A title change and approvals stay allowed.
        yield* h.coordinator.hooks.interceptClientCommand({
          type: "thread.meta.update",
          commandId: "c" as never,
          threadId: pair.builderThreadId,
          title: "Renamed",
        });
        yield* h.coordinator.hooks.interceptClientCommand({
          type: "thread.approval.respond",
          commandId: "c" as never,
          threadId: pair.builderThreadId,
          requestId: "r" as never,
          decision: "accept",
          createdAt: NOW,
        } as OrchestrationCommand);
      }),
    );

    it.effect("archive, unarchive and delete follow the Lead", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        yield* delegate(h);
        const event = (type: string, threadId: string, sequence: number) =>
          ({
            type,
            sequence,
            payload: { threadId },
            commandId: null,
          }) as unknown as OrchestrationEvent;
        yield* h.coordinator.hooks.onDomainEvent(event("thread.archived", pair.leadThreadId, 10));
        assert.equal((yield* h.pair()).hold?.kind, "stop");
        assert.isNotNull(h.runtime.threads.get(pair.builderThreadId)?.archivedAt);
        yield* h.coordinator.hooks.onDomainEvent(event("thread.unarchived", pair.leadThreadId, 11));
        assert.isNull(h.runtime.threads.get(pair.builderThreadId)?.archivedAt);

        const removed = yield* h.coordinator.service.streamEvents({}).pipe(
          Stream.filter((entry: HelixStreamEvent) => entry.type === "pair-removed"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* drain;
        yield* h.coordinator.hooks.onDomainEvent(event("thread.deleted", pair.leadThreadId, 12));
        assert.isFalse(h.runtime.threads.has(pair.builderThreadId));
        assert.isNull(yield* h.repository.getPair(pair.id).pipe(Effect.orDie));
        // The former Builder is retired for good, never an ordinary chat.
        assert.isTrue(h.coordinator.hooks.roleOf(pair.builderThreadId)?.retired);
        assert.equal(h.profiles.get(pair.builderThreadId)?.kind, "helix_retired");
        const events = yield* Fiber.join(removed);
        assert.lengthOf([...events], 1);
      }),
    );

    it.effect("streams pair and handoff upserts", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        const collected = yield* h.coordinator.service
          .streamEvents({ leadThreadId: pair.leadThreadId })
          .pipe(Stream.take(4), Stream.runCollect, Effect.forkChild);
        yield* drain;
        yield* delegate(h);
        const events = [...(yield* Fiber.join(collected))];
        assert.equal(events[0]?.type, "snapshot");
        assert.isTrue(events.some((event) => event.type === "pair-upserted"));
        assert.isTrue(events.some((event) => event.type === "handoff-upserted"));
      }),
    );

    it.effect("gives both participants role instructions and nobody else", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        const leadRole = yield* h.coordinator.hooks.sessionRoleFor(pair.leadThreadId);
        assert.equal(leadRole?.role, "lead");
        assert.include(leadRole?.instructions ?? "", "helix_delegate");
        const builderRole = yield* h.coordinator.hooks.sessionRoleFor(pair.builderThreadId);
        assert.equal(builderRole?.role, "builder");
        assert.include(builderRole?.instructions ?? "", "helix_report");
        assert.isNull(yield* h.coordinator.hooks.sessionRoleFor(ThreadId.makeUnsafe("ordinary")));
        // With the setting off, the Lead is an ordinary chat again.
        yield* Ref.set(h.enabled, false);
        assert.isNull(yield* h.coordinator.hooks.sessionRoleFor(pair.leadThreadId));
      }),
    );

    it.effect(
      "refuses sub-agent, Hub and unsupported-provider Leads, and stays off when disabled",
      () =>
        Effect.gen(function* () {
          const runtime = new FakeRuntime();
          runtime.threads.set(
            "child",
            shell("child", { parentThreadId: ThreadId.makeUnsafe("parent") }),
          );
          runtime.threads.set(
            "pi-lead",
            shell("pi-lead", {
              modelSelection: Schema.decodeSync(ModelSelection)({ provider: "pi", model: "x" }),
            }),
          );
          const h = yield* makeHarness({ runtime, enable: false });
          const enable = (leadThreadId: string, builderModelSelection = codex) =>
            h.coordinator.service
              .enable({ leadThreadId: ThreadId.makeUnsafe(leadThreadId), builderModelSelection })
              .pipe(
                Effect.flip,
                Effect.map((error) => error.code),
              );
          assert.equal(yield* enable("child"), "HELIX_UNSUPPORTED_THREAD");
          assert.equal(yield* enable("pi-lead"), "HELIX_UNSUPPORTED_PROVIDER");
          assert.equal(
            yield* enable(
              h.lead.threadId,
              Schema.decodeSync(ModelSelection)({ provider: "cursor", model: "auto" }),
            ),
            "HELIX_UNSUPPORTED_PROVIDER",
          );
          const hub = yield* makeHarness({ hub: true, enable: false });
          assert.equal(
            yield* hub.coordinator.service
              .enable({ leadThreadId: hub.lead.threadId, builderModelSelection: codex })
              .pipe(
                Effect.flip,
                Effect.map((error) => error.code),
              ),
            "HELIX_UNSUPPORTED_THREAD",
          );
          const off = yield* makeHarness({ enabled: false, enable: false });
          assert.equal(
            yield* off.coordinator.service
              .enable({ leadThreadId: off.lead.threadId, builderModelSelection: codex })
              .pipe(
                Effect.flip,
                Effect.map((error) => error.code),
              ),
            "HELIX_DISABLED",
          );
        }),
    );

    it.effect("is inert for threads outside a pair, with the setting on or off", () =>
      Effect.gen(function* () {
        for (const enabled of [true, false]) {
          const h = yield* makeHarness({ enabled, enable: false });
          for (const threadId of ["ordinary", "hub-coordinator", "hub-worker", "native-child"]) {
            const id = ThreadId.makeUnsafe(threadId);
            assert.isNull(h.coordinator.hooks.roleOf(id));
            assert.isNull(yield* h.coordinator.hooks.sessionRoleFor(id));
            assert.isTrue(
              yield* h.coordinator.hooks.admitAutomaticTurn({ threadId: id, messageId: "msg-1" }),
            );
            for (const command of [
              { type: "thread.turn.interrupt", commandId: "c", threadId, createdAt: NOW },
              { type: "thread.archive", commandId: "c", threadId },
              { type: "thread.delete", commandId: "c", threadId },
              { type: "thread.meta.update", commandId: "c", threadId, branch: "x" },
            ]) {
              yield* h.coordinator.hooks.interceptClientCommand(
                command as unknown as OrchestrationCommand,
              );
            }
          }
          assert.lengthOf(h.runtime.commands, 0);
          assert.isFalse(h.coordinator.hooks.builderThreadIds().has("ordinary"));
        }
      }),
    );

    it.effect("tools refuse callers outside the pair and roles that do not match", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const stranger: HelixToolCaller = { ...h.lead, threadId: ThreadId.makeUnsafe("stranger") };
        const error = yield* flip(delegate({ ...h, lead: stranger }));
        assert.equal((error as GatewayToolError).code, "helix_no_pair");
        const asBuilder = yield* flip(
          h.coordinator.port.report(
            { ...h.builder(), role: "builder", threadId: h.lead.threadId },
            {
              outcome: "completed",
              summary: "x",
            },
          ),
        );
        assert.equal((asBuilder as GatewayToolError).code, "helix_no_pair");
        yield* Ref.set(h.enabled, false);
        const off = yield* flip(delegate(h));
        assert.equal((off as GatewayToolError).code, "helix_disabled");
      }),
    );

    it.effect("disables an idle pair, archiving the Builder and dropping the Lead tools", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        yield* delegate(h);
        const busy = yield* h.coordinator.service
          .disable({ pairId: pair.id, expectedRevision: (yield* h.pair()).revision })
          .pipe(Effect.flip);
        assert.equal(busy.code, "HELIX_PAIR_BUSY");
        yield* completeLatestBrief(h, "t1");
        yield* h.coordinator.port.review(h.lead, {
          handoffId: (yield* latest(h)).id,
          requestId: "ok",
          verdict: "accepted",
        });
        const stale = yield* h.coordinator.service
          .disable({ pairId: pair.id, expectedRevision: 0 })
          .pipe(Effect.flip);
        assert.equal(stale.code, "HELIX_STALE_REVISION");
        const view = yield* h.coordinator.service.disable({
          pairId: pair.id,
          expectedRevision: (yield* h.pair()).revision,
        });
        assert.equal(view.summary.lifecycle, "disabled");
        assert.isNull(h.profiles.get(pair.leadThreadId));
        assert.equal(h.profiles.get(pair.builderThreadId)?.kind, "helix_builder");
        assert.isNotNull(h.runtime.threads.get(pair.builderThreadId)?.archivedAt);
        // Launches without a role clear the persisted one.
        assert.isNull(yield* h.coordinator.hooks.sessionRoleFor(pair.leadThreadId));
        // A Builder stays a Builder while its pair row exists: same as its credential.
        assert.equal(
          (yield* h.coordinator.hooks.sessionRoleFor(pair.builderThreadId))?.role,
          "builder",
        );
      }),
    );

    it.effect(
      "maps a refused Builder start (e.g. an unusable model) to a visible failed handoff",
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const pair = yield* h.pair();
          yield* delegate(h);
          const handoff = yield* latest(h);
          const builder = h.runtime.threads.get(pair.builderThreadId)!;
          h.runtime.threads.set(pair.builderThreadId, {
            ...builder,
            session: {
              threadId: pair.builderThreadId,
              status: "error",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: "Model gpt-5.3-codex-spark is not available on this account.",
              updatedAt: NOW,
            } as OrchestrationThreadShell["session"],
          });
          h.runtime.deliveries.set(
            `${pair.builderThreadId}|${handoff.dispatch!.messageId}`,
            "dead",
          );
          yield* h.coordinator.hooks.sweep();
          const failed = yield* latest(h);
          assert.equal(failed.state, "failed");
          assert.include(failed.failure?.reason ?? "", "not available on this account");
          assert.isNull((yield* h.pair()).hold);
          // The Lead is told through a wake, and nothing is resent.
          assert.lengthOf(h.runtime.turnStarts(pair.leadThreadId), 1);
          assert.lengthOf(h.runtime.turnStarts(pair.builderThreadId), 1);
        }),
    );
  });

  describe("server-turn gate and workspace guards", () => {
    const serverTurn = (h: Harness, threadId: string, messageId: string, origin?: string) =>
      h.coordinator.hooks.shouldSendServerTurn({
        threadId: ThreadId.makeUnsafe(threadId),
        messageId,
        ...(origin === undefined ? {} : { dispatchOrigin: origin }),
      });

    it.effect("refuses every non-brief turn on a Builder and server turns on a stopped Lead", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        yield* delegate(h);
        const handoff = yield* latest(h);
        const builder = pair.builderThreadId;
        // The current brief runs; nothing else does on the Builder.
        assert.isTrue(yield* serverTurn(h, builder, handoff.dispatch!.messageId, "agent"));
        for (const [messageId, origin] of [
          ["usage-limit:resume-1", undefined],
          ["automation:nightly", "automation"],
          ["quit-resume:1", "agent"],
          ["goal-continuation:1", "agent"],
          ["server:anything", undefined],
          ["user:typed", "user"],
        ] as const) {
          assert.isFalse(yield* serverTurn(h, builder, messageId, origin), messageId);
        }
        // An attempt that is not current never runs, on either thread.
        assert.isFalse(yield* serverTurn(h, builder, helixBriefMessageId(handoff.id, 2), "agent"));
        assert.isFalse(
          yield* serverTurn(h, pair.leadThreadId, handoff.dispatch!.messageId, "agent"),
        );

        // A Lead is an ordinary chat for non-Helix turns, before and after a Stop
        // (a Helix hold is about Helix work); its Helix wake is what Stop ends.
        assert.isTrue(yield* serverTurn(h, pair.leadThreadId, "automation:a", "automation"));
        yield* h.coordinator.service.stop({ pairId: pair.id });
        assert.isTrue(yield* serverTurn(h, pair.leadThreadId, "automation:a", "automation"));
        assert.isTrue(yield* serverTurn(h, pair.leadThreadId, "usage-limit:r"));
        assert.isTrue(yield* serverTurn(h, pair.leadThreadId, "user:m", "user"));
        // The stopped brief never runs, and asking twice gives the same answer.
        assert.isFalse(yield* serverTurn(h, builder, handoff.dispatch!.messageId, "agent"));
        assert.isFalse(yield* serverTurn(h, builder, handoff.dispatch!.messageId, "agent"));
        // Under the stop hold nothing restarts the loop: delegate is refused.
        assert.equal(
          ((yield* flip(delegate(h, "after-stop"))) as GatewayToolError).code,
          "helix_pair_held",
        );

        // Threads outside a pair are untouched.
        assert.isTrue(yield* serverTurn(h, "someone-else", "usage-limit:x"));
      }),
    );

    it.effect("refuses a checkpoint revert while either side of the shared workspace works", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        const revert = (threadId: string) =>
          h.coordinator.hooks
            .interceptClientCommand({
              type: "thread.checkpoint.revert",
              commandId: "revert" as never,
              threadId: ThreadId.makeUnsafe(threadId),
              turnCount: 0,
              createdAt: NOW,
            } as OrchestrationCommand)
            .pipe(Effect.result);
        yield* delegate(h);
        assert.equal((yield* latest(h)).state, "running");
        assert.isTrue((yield* revert(pair.leadThreadId))._tag === "Failure");
        assert.isTrue((yield* revert(pair.builderThreadId))._tag === "Failure");

        yield* completeLatestBrief(h, "b-1");
        yield* h.coordinator.port.review(h.lead, {
          handoffId: (yield* latest(h)).id,
          requestId: "ok",
          verdict: "accepted",
          waitSeconds: 0,
        });
        // No handoff in flight, but the Builder's session is still running a turn.
        const builder = h.runtime.threads.get(pair.builderThreadId)!;
        h.runtime.threads.set(pair.builderThreadId, {
          ...builder,
          session: {
            threadId: pair.builderThreadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: TurnId.makeUnsafe("b-extra"),
            lastError: null,
            updatedAt: NOW,
          } as OrchestrationThreadShell["session"],
        });
        const busy = yield* revert(pair.leadThreadId);
        assert.isTrue(busy._tag === "Failure");
        if (busy._tag === "Failure") assert.include(busy.failure.message, "The Builder is working");
        h.runtime.threads.set(pair.builderThreadId, { ...builder, session: null });
        assert.isTrue((yield* revert(pair.leadThreadId))._tag === "Success");
      }),
    );

    it.effect("refuses delegation and corrections from a Lead in plan mode", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        yield* delegate(h);
        yield* completeLatestBrief(h, "b-1");
        const lead = h.runtime.threads.get(pair.leadThreadId)!;
        h.runtime.threads.set(pair.leadThreadId, { ...lead, interactionMode: "plan" });
        const refusedDelegate = (yield* flip(delegate(h, "second"))) as GatewayToolError;
        assert.include(refusedDelegate.message, "plan mode");
        const refusedReview = (yield* flip(
          h.coordinator.port.review(h.lead, {
            handoffId: (yield* latest(h)).id,
            requestId: "more",
            verdict: "changes_requested",
            feedback: "More.",
            waitSeconds: 0,
          }),
        )) as GatewayToolError;
        assert.include(refusedReview.message, "plan mode");
        // Accepting is still allowed: it changes no files.
        yield* h.coordinator.port.review(h.lead, {
          handoffId: (yield* latest(h)).id,
          requestId: "accept",
          verdict: "accepted",
          waitSeconds: 0,
        });
        assert.lengthOf(h.runtime.turnStarts(pair.builderThreadId), 1);
      }),
    );

    it.effect("runs the Builder no looser than its Lead and in the Lead's current workspace", () =>
      Effect.gen(function* () {
        const runtime = new FakeRuntime();
        runtime.threads.set("lead-strict", shell("lead-strict", { runtimeMode: "full-access" }));
        const h = yield* makeHarness({ runtime, leadId: "lead-strict" });
        const pair = yield* h.pair();
        assert.equal(pair.config.builderRuntimeMode, "full-access");
        // The user lowers the Lead's mode after enabling.
        const lead = runtime.threads.get("lead-strict")!;
        runtime.threads.set("lead-strict", { ...lead, runtimeMode: "approval-required" });
        yield* delegate(h);
        const create = runtime.commands.find((command) => command.type === "thread.create");
        assert.equal(
          create?.type === "thread.create" ? create.runtimeMode : null,
          "approval-required",
        );
        const [first] = runtime.turnStarts(pair.builderThreadId);
        assert.equal(
          first?.type === "thread.turn.start" ? first.runtimeMode : null,
          "approval-required",
        );
        yield* completeLatestBrief(h, "b-1");
        yield* h.coordinator.port.review(h.lead, {
          handoffId: (yield* latest(h)).id,
          requestId: "ok",
          verdict: "accepted",
          waitSeconds: 0,
        });

        // The Lead's workspace moved (e.g. before Helix guarded it): the next brief follows it.
        runtime.threads.set("lead-strict", {
          ...runtime.threads.get("lead-strict")!,
          branch: "feature/next",
          worktreePath: "/tmp/worktrees/next",
        });
        yield* delegate(h, "second");
        const sync = runtime.commands.find(
          (command) =>
            command.type === "thread.meta.update" &&
            command.commandId.startsWith("helix:sync-workspace:"),
        );
        assert.equal(sync?.type, "thread.meta.update");
        if (sync?.type === "thread.meta.update") {
          assert.equal(sync.threadId, pair.builderThreadId);
          assert.equal(sync.branch, "feature/next");
          assert.equal(sync.worktreePath, "/tmp/worktrees/next");
        }
        // The sync lands before the brief that needs it.
        const syncIndex = runtime.commands.indexOf(sync!);
        const secondBrief = runtime.turnStarts(pair.builderThreadId)[1]!;
        assert.isTrue(syncIndex < runtime.commands.indexOf(secondBrief));
      }),
    );
  });

  describe("review round: restart branches, quarantine and pair guards", () => {
    const restartOver = (h: Harness) =>
      Effect.gen(function* () {
        const coordinator = yield* makeHelixCoordinator({
          repository: h.repository,
          runtime: h.runtime.shape,
          isEnabled: Effect.succeed(true),
          setRoleProfile: (threadId, profile) => h.profiles.set(threadId, profile),
        });
        yield* coordinator.hooks.reconcileStartup();
        return coordinator;
      });

    /** A wake committed as requested whose engine dispatch never returned. */
    const wakeRequestedThenCrash = (h: Harness) =>
      Effect.gen(function* () {
        yield* delegate(h);
        h.runtime.unknownOutcomeTypes.add("thread.turn.start");
        yield* completeLatestBrief(h, "t1");
        h.runtime.unknownOutcomeTypes.delete("thread.turn.start");
        const handoff = yield* latest(h);
        assert.equal(handoff.delivery, "wake_requested");
        return handoff;
      });

    it.effect(
      "wake_requested at a crash: unsent wakes wait for Resume, sent ones are not resent",
      () =>
        Effect.gen(function* () {
          // Never reached the engine: suppressed back to pending, delivered once on Resume.
          const h = yield* makeHarness();
          const pair = yield* h.pair();
          yield* wakeRequestedThenCrash(h);
          const restarted = yield* restartOver(h);
          assert.equal((yield* latest(h)).delivery, "pending");
          assert.equal((yield* h.pair()).hold?.kind, "restart");
          assert.lengthOf(h.runtime.turnStarts(pair.leadThreadId), 0);
          yield* restarted.service.resume({
            pairId: pair.id,
            expectedRevision: (yield* h.pair()).revision,
          });
          yield* restarted.hooks.sweep();
          assert.lengthOf(h.runtime.turnStarts(pair.leadThreadId), 1);
          assert.equal((yield* latest(h)).delivery, "wake_dispatched");

          // The engine took it before the crash: recorded as dispatched, never sent again.
          const h2 = yield* makeHarness();
          const pair2 = yield* h2.pair();
          const handoff2 = yield* wakeRequestedThenCrash(h2);
          h2.runtime.accepted.add(handoff2.wake!.commandId);
          const restarted2 = yield* restartOver(h2);
          assert.equal((yield* latest(h2)).delivery, "wake_dispatched");
          yield* restarted2.hooks.sweep();
          assert.lengthOf(h2.runtime.turnStarts(pair2.leadThreadId), 0);
        }),
    );

    it.effect("refuses to enable when Builder restrictions cannot be applied", () =>
      Effect.gen(function* () {
        const runtime = new FakeRuntime();
        runtime.threads.set("lead-no-profiles", shell("lead-no-profiles"));
        const coordinator = yield* makeHelixCoordinator({
          repository: yield* HelixRepository,
          runtime: runtime.shape,
          isEnabled: Effect.succeed(true),
        });
        const error = yield* flip(
          coordinator.service.enable({
            leadThreadId: ThreadId.makeUnsafe("lead-no-profiles"),
            builderModelSelection: codex,
          }),
        );
        assert.equal(error.code, "HELIX_UNAVAILABLE");
        assert.isNull(
          yield* (yield* HelixRepository)
            .getPairByLeadThread(ThreadId.makeUnsafe("lead-no-profiles"))
            .pipe(Effect.orDie),
        );
      }),
    );

    it.effect("keeps an active Lead's workspace and provider inside what the pair supports", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        const refusal = (command: Record<string, unknown>) =>
          h.coordinator.hooks
            .interceptClientCommand({
              commandId: "c" as never,
              threadId: pair.leadThreadId,
              ...command,
            } as unknown as OrchestrationCommand)
            .pipe(Effect.result);
        for (const command of [
          { type: "thread.meta.update", worktreePath: "/tmp/elsewhere" },
          { type: "thread.meta.update", branch: "other" },
          { type: "thread.meta.update", modelSelection: { provider: "cursor", model: "x" } },
          { type: "thread.handoff.create", sourceThreadId: pair.leadThreadId },
        ]) {
          assert.equal((yield* refusal(command))._tag, "Failure", JSON.stringify(command));
        }
        // A Builder model change goes through Helix settings, not the thread.
        const builderModel = yield* h.coordinator.hooks
          .interceptClientCommand({
            type: "thread.meta.update",
            commandId: "c" as never,
            threadId: pair.builderThreadId,
            modelSelection: claude,
          } as OrchestrationCommand)
          .pipe(Effect.result);
        assert.equal(builderModel._tag, "Failure");
        // Title changes and supported model switches pass.
        assert.equal((yield* refusal({ type: "thread.meta.update", title: "T" }))._tag, "Success");
        assert.equal(
          (yield* refusal({ type: "thread.meta.update", modelSelection: codex }))._tag,
          "Success",
        );
        // Workspace moves outside the command path.
        assert.equal(
          (yield* h.coordinator.hooks.assertMayMoveWorkspace(pair.leadThreadId).pipe(Effect.result))
            ._tag,
          "Failure",
        );
        assert.equal(
          (yield* h.coordinator.hooks.assertMayMoveWorkspace("someone-else").pipe(Effect.result))
            ._tag,
          "Success",
        );
      }),
    );

    it.effect("surfaces a Builder model change the engine refuses", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        yield* delegate(h);
        yield* completeLatestBrief(h, "b-1");
        yield* h.coordinator.port.review(h.lead, {
          handoffId: (yield* latest(h)).id,
          requestId: "ok",
          verdict: "accepted",
          waitSeconds: 0,
        });
        h.runtime.rejectTypes.add("thread.meta.update");
        const error = yield* flip(
          h.coordinator.service.updateConfig({
            pairId: pair.id,
            expectedRevision: (yield* h.pair()).revision,
            builderModelSelection: claude,
          }),
        );
        assert.include(error.message, "could not be changed");
        h.runtime.rejectTypes.delete("thread.meta.update");
        // The next brief carries the configured model explicitly.
        yield* delegate(h, "second");
        const second = h.runtime.turnStarts(pair.builderThreadId)[1];
        assert.deepStrictEqual(
          second?.type === "thread.turn.start" ? second.modelSelection : null,
          claude,
        );
      }),
    );

    it.effect("quarantines an undecodable pair instead of failing, and fails it closed", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const bad = yield* makeHarness();
        const badPair = yield* bad.pair();
        const rows = yield* sql<{ configJson: string }>`
          SELECT config_json AS "configJson" FROM helix_pairs WHERE pair_id = ${badPair.id}
        `;
        const configJson = rows[0]!.configJson;
        yield* sql`UPDATE helix_pairs SET config_json = '{"broken":' WHERE pair_id = ${badPair.id}`;
        const profiles = new Map<string, AgentGatewayRoleProfile | null>();
        // Building the coordinator still succeeds.
        const coordinator = yield* makeHelixCoordinator({
          repository: bad.repository,
          runtime: bad.runtime.shape,
          isEnabled: Effect.succeed(true),
          setRoleProfile: (threadId, profile) => profiles.set(threadId, profile),
        }).pipe(
          Effect.ensuring(
            sql`UPDATE helix_pairs SET config_json = ${configJson} WHERE pair_id = ${badPair.id}`.pipe(
              Effect.orDie,
            ),
          ),
        );
        // Its Builder stays restricted; its Lead loses the Lead role; no server turn runs.
        assert.equal(profiles.get(badPair.builderThreadId)?.kind, "helix_builder");
        assert.notEqual(profiles.get(badPair.leadThreadId)?.kind, "helix_lead");
        assert.isNull(yield* coordinator.hooks.sessionRoleFor(badPair.leadThreadId));
        assert.equal(
          (yield* coordinator.hooks.sessionRoleFor(badPair.builderThreadId))?.role,
          "builder",
        );
        // The Builder runs nothing; the Lead's non-Helix turns run as in any chat.
        assert.isFalse(
          yield* coordinator.hooks.shouldSendServerTurn({
            threadId: badPair.builderThreadId,
            messageId: "automation:x",
            dispatchOrigin: "automation",
          }),
        );
        assert.isTrue(
          yield* coordinator.hooks.shouldSendServerTurn({
            threadId: badPair.leadThreadId,
            messageId: "automation:x",
            dispatchOrigin: "automation",
          }),
        );
      }),
    );
  });

  describe("review round 2: bounded retries, fences, removal and setting changes", () => {
    it.effect("a wake the engine keeps refusing is capped, then held visibly", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        yield* delegate(h);
        h.runtime.rejectTypes.add("thread.turn.start");
        yield* completeLatestBrief(h, "t1");
        for (let sweep = 0; sweep < 12; sweep += 1) yield* h.coordinator.hooks.sweep();
        const handoff = yield* latest(h);
        assert.equal(handoff.wakeAttempts, HELIX_MAX_WAKE_ATTEMPTS);
        assert.equal(handoff.delivery, "pending");
        const held = yield* h.pair();
        assert.equal(held.hold?.kind, "uncertain");
        assert.include(held.hold?.reason ?? "", "could not wake the Lead");
        // No further attempt after the cap, however often the sweep runs.
        for (let sweep = 0; sweep < 5; sweep += 1) yield* h.coordinator.hooks.sweep();
        assert.equal((yield* latest(h)).wakeAttempts, HELIX_MAX_WAKE_ATTEMPTS);
        assert.equal(pair.id, held.id);
      }),
    );

    it.effect("a Stop that cannot commit fences the pair until a durable stop commits", () =>
      Effect.gen(function* () {
        const base = yield* HelixRepository;
        let failCommits = false;
        const runtime = new FakeRuntime();
        const leadId = "lead-fence";
        runtime.threads.set(leadId, shell(leadId));
        const profiles = new Map<string, AgentGatewayRoleProfile | null>();
        const coordinator = yield* makeHelixCoordinator({
          repository: {
            ...base,
            commit: (input) =>
              failCommits
                ? Effect.fail(new HelixRepositoryError({ code: "storage", message: "busy" }))
                : base.commit(input),
          },
          runtime: runtime.shape,
          isEnabled: Effect.succeed(true),
          setRoleProfile: (threadId, profile) => profiles.set(threadId, profile),
          newThreadId: () => ThreadId.makeUnsafe("builder-fence"),
        });
        yield* coordinator.service.enable({
          leadThreadId: ThreadId.makeUnsafe(leadId),
          builderModelSelection: codex,
        });
        const caller: HelixToolCaller = {
          threadId: ThreadId.makeUnsafe(leadId),
          turnId: TurnId.makeUnsafe("lt-fence"),
          sessionKey: "l",
          provider: "claudeAgent",
          role: "lead",
        };
        yield* coordinator.port.delegate(caller, { requestId: "a", brief, waitSeconds: 0 });
        const pair = (yield* base
          .getPairByLeadThread(ThreadId.makeUnsafe(leadId))
          .pipe(Effect.orDie))!;
        const handoff = (yield* base.listHandoffs(pair.id).pipe(Effect.orDie))[0]!;
        failCommits = true;
        yield* coordinator.hooks.interceptClientCommand({
          type: "thread.turn.interrupt",
          commandId: "stop" as never,
          threadId: ThreadId.makeUnsafe(leadId),
          createdAt: NOW,
        });
        // Not committed, yet the Builder was interrupted and its brief is refused.
        assert.isNull((yield* base.getPair(pair.id).pipe(Effect.orDie))!.hold);
        assert.isAbove(
          runtime.commands.filter(
            (command) =>
              command.type === "thread.turn.interrupt" && command.threadId === pair.builderThreadId,
          ).length,
          0,
        );
        const briefTurn = {
          threadId: pair.builderThreadId,
          messageId: handoff.dispatch!.messageId,
          dispatchOrigin: "agent",
        };
        assert.isFalse(yield* coordinator.hooks.shouldSendServerTurn(briefTurn));
        // Storage recovers: the sweep commits the Stop and the fence lifts.
        failCommits = false;
        yield* coordinator.hooks.sweep();
        const stopped = (yield* base.getPair(pair.id).pipe(Effect.orDie))!;
        assert.equal(stopped.hold?.kind, "stop");
        assert.equal(stopped.cancellationEpoch, pair.cancellationEpoch + 1);
        assert.isFalse(yield* coordinator.hooks.shouldSendServerTurn(briefTurn));
      }),
    );

    it.effect(
      "an unreadable handoff row quarantines the pair at runtime; removal frees both chats",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const h = yield* makeHarness();
          const pair = yield* h.pair();
          yield* delegate(h);
          const handoff = yield* latest(h);
          yield* sql`UPDATE helix_handoffs SET record_json = '{"broken":' WHERE handoff_id = ${handoff.id}`;
          // Only a Stop commits on a pair whose data cannot be read.
          const refused = yield* flip(
            h.coordinator.service.pause({ pairId: pair.id, expectedRevision: pair.revision }),
          );
          assert.include(refused.message, "could not be read");
          yield* h.coordinator.service.stop({ pairId: pair.id });
          const listed = yield* h.coordinator.service.listPairs();
          assert.isFalse(listed.pairs.some((summary) => summary.pairId === pair.id));
          assert.deepInclude(listed.quarantined?.map((entry) => entry.pairId) ?? [], pair.id);
          assert.isNull(yield* h.coordinator.service.getPair({ leadThreadId: pair.leadThreadId }));

          const removed = yield* h.coordinator.service.removePair({ pairId: pair.id });
          assert.isTrue(removed.removed);
          assert.isNull(h.coordinator.hooks.roleOf(pair.leadThreadId));
          assert.isTrue(h.coordinator.hooks.roleOf(pair.builderThreadId)?.retired);
          assert.equal(h.profiles.get(pair.builderThreadId)?.kind, "helix_retired");
          assert.isNull(yield* h.repository.getPair(pair.id).pipe(Effect.orDie));
          // The Builder was archived, and the Lead takes any command again.
          assert.isTrue(
            h.runtime.commands.some(
              (command) =>
                command.type === "thread.archive" && command.threadId === pair.builderThreadId,
            ),
          );
          yield* h.coordinator.hooks.interceptClientCommand({
            type: "thread.meta.update",
            commandId: "c" as never,
            threadId: pair.leadThreadId,
            worktreePath: "/tmp/elsewhere",
          });
          assert.lengthOf((yield* h.coordinator.service.listPairs()).quarantined ?? [], 0);
        }),
    );

    it.effect("Pause lets the current brief start and run; it stops only new dispatches", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        yield* delegate(h);
        const handoff = yield* latest(h);
        yield* h.coordinator.service.pause({
          pairId: pair.id,
          expectedRevision: (yield* h.pair()).revision,
        });
        const brief = {
          threadId: pair.builderThreadId,
          messageId: handoff.dispatch!.messageId,
          dispatchOrigin: "agent",
        };
        // Admission at promotion, the pre-send check and the post-bind check all agree.
        assert.isTrue(yield* h.coordinator.hooks.admitAutomaticTurn(brief));
        assert.isTrue(yield* h.coordinator.hooks.shouldSendServerTurn(brief));
        assert.equal((yield* latest(h)).state, "running");
        // The setting turned off behaves the same for the running brief.
        yield* Ref.set(h.enabled, false);
        assert.isTrue(yield* h.coordinator.hooks.shouldSendServerTurn(brief));
        yield* Ref.set(h.enabled, true);
        // Its result is held, not woken, while paused.
        yield* completeLatestBrief(h, "t1");
        assert.equal((yield* latest(h)).delivery, "pending");
        assert.lengthOf(h.runtime.turnStarts(pair.leadThreadId), 0);
      }),
    );

    it.effect("effects survive the caller being interrupted mid-dispatch", () =>
      Effect.gen(function* () {
        const runtime = new FakeRuntime();
        runtime.turnStartGate = yield* Deferred.make<void>();
        const h = yield* makeHarness({ runtime });
        const caller = yield* delegate(h).pipe(Effect.forkChild);
        yield* drain;
        assert.equal((yield* latest(h)).state, "dispatching");
        // The Lead's tool call is cancelled while the engine has the brief.
        yield* Fiber.interrupt(caller);
        yield* Deferred.succeed(runtime.turnStartGate, undefined);
        runtime.turnStartGate = null;
        yield* drain;
        const handoff = yield* latest(h);
        assert.equal(handoff.state, "running");
        assert.lengthOf(runtime.turnStarts((yield* h.pair()).builderThreadId), 1);
      }),
    );

    it.effect("re-enable re-caps the Builder's mode and pins the current role text", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const runtime = new FakeRuntime();
        runtime.threads.set(
          "lead-reenable",
          shell("lead-reenable", { runtimeMode: "full-access" }),
        );
        const h = yield* makeHarness({ runtime, leadId: "lead-reenable" });
        const pair = yield* h.pair();
        assert.equal(pair.config.builderRuntimeMode, "full-access");
        // An older server pinned the previous role text.
        yield* sql`UPDATE helix_pairs SET config_json = ${JSON.stringify({
          ...pair.config,
          rolePromptVersions: { lead: "helix-roles/1", builder: "helix-roles/1" },
        })} WHERE pair_id = ${pair.id}`;
        const off = yield* h.coordinator.service.disable({
          pairId: pair.id,
          expectedRevision: pair.revision,
        });
        runtime.threads.set("lead-reenable", {
          ...runtime.threads.get("lead-reenable")!,
          runtimeMode: "approval-required",
        });
        const on = yield* h.coordinator.service.enable({
          leadThreadId: pair.leadThreadId,
          builderModelSelection: codex,
          expectedRevision: off.summary.revision,
        });
        assert.equal(on.pair.config.builderRuntimeMode, "approval-required");
        assert.deepStrictEqual(on.pair.config.rolePromptVersions, {
          lead: HELIX_ROLE_PROMPT_VERSION,
          builder: HELIX_ROLE_PROMPT_VERSION,
        });
        // The text a session starts with is the current one.
        assert.equal(
          (yield* h.coordinator.hooks.sessionRoleFor(pair.leadThreadId))?.promptVersion,
          HELIX_ROLE_PROMPT_VERSION,
        );
      }),
    );

    it.effect("an idle pair pinned to old role text is upgraded by the sweep", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const h = yield* makeHarness();
        const pair = yield* h.pair();
        yield* sql`UPDATE helix_pairs SET config_json = ${JSON.stringify({
          ...pair.config,
          rolePromptVersions: { lead: "helix-roles/1", builder: "helix-roles/1" },
        })} WHERE pair_id = ${pair.id}`;
        yield* h.coordinator.hooks.sweep();
        assert.deepStrictEqual((yield* h.pair()).config.rolePromptVersions, {
          lead: HELIX_ROLE_PROMPT_VERSION,
          builder: HELIX_ROLE_PROMPT_VERSION,
        });
      }),
    );

    it.effect(
      "turning the setting off drops the Lead's tools and guards; the Builder stays restricted",
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const pair = yield* h.pair();
          assert.equal(h.profiles.get(pair.leadThreadId)?.kind, "helix_lead");
          yield* Ref.set(h.enabled, false);
          yield* h.coordinator.hooks.sweep();
          assert.isNull(h.profiles.get(pair.leadThreadId));
          assert.equal(h.profiles.get(pair.builderThreadId)?.kind, "helix_builder");
          // No Builder at work: the Lead's workspace may move.
          yield* h.coordinator.hooks.interceptClientCommand({
            type: "thread.meta.update",
            commandId: "c" as never,
            threadId: pair.leadThreadId,
            branch: "other",
          });
          yield* Ref.set(h.enabled, true);
          yield* h.coordinator.hooks.sweep();
          assert.equal(h.profiles.get(pair.leadThreadId)?.kind, "helix_lead");
        }),
    );

    it.effect("guards a git hand off by the directory it acts on, not only the thread", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const refusal = yield* flip(
          h.coordinator.hooks.assertMayMoveWorkspace("another-thread", "/tmp/worktrees/login/"),
        );
        assert.equal(refusal.reason, "workspace_in_pair");
        yield* h.coordinator.hooks.assertMayMoveWorkspace("another-thread", "/tmp/worktrees/other");
      }),
    );

    it.effect("a deleted Builder of a disabled pair is replaced lazily at the next dispatch", () =>
      Effect.gen(function* () {
        let next = 0;
        const runtime = new FakeRuntime();
        runtime.threads.set("lead-replace", shell("lead-replace"));
        const repository = yield* HelixRepository;
        const profiles = new Map<string, AgentGatewayRoleProfile | null>();
        const enabled = yield* Ref.make(true);
        const coordinator = yield* makeHelixCoordinator({
          repository,
          runtime: runtime.shape,
          isEnabled: Ref.get(enabled),
          setRoleProfile: (threadId, profile) => profiles.set(threadId, profile),
          newThreadId: () => ThreadId.makeUnsafe(`builder-replace-${(next += 1)}`),
        });
        const first = yield* coordinator.service.enable({
          leadThreadId: ThreadId.makeUnsafe("lead-replace"),
          builderModelSelection: codex,
        });
        const off = yield* coordinator.service.disable({
          pairId: first.pair.id,
          expectedRevision: first.summary.revision,
        });
        const oldBuilder = first.pair.builderThreadId;
        runtime.threads.set(oldBuilder, shell(oldBuilder));
        yield* coordinator.hooks.interceptClientCommand({
          type: "thread.delete",
          commandId: "del" as never,
          threadId: oldBuilder,
        });
        yield* coordinator.hooks.onDomainEvent({
          type: "thread.deleted",
          sequence: 5,
          payload: { threadId: oldBuilder },
        } as unknown as OrchestrationEvent);
        const replaced = (yield* repository.getPair(first.pair.id).pipe(Effect.orDie))!;
        assert.notEqual(replaced.builderThreadId, oldBuilder);
        assert.isNull(replaced.builderCreatedAt);
        assert.isTrue(coordinator.hooks.roleOf(oldBuilder)?.retired);
        assert.equal(profiles.get(oldBuilder)?.kind, "helix_retired");
        assert.equal(profiles.get(replaced.builderThreadId)?.kind, "helix_builder");
        assert.equal(off.summary.lifecycle, "disabled");
      }),
    );
  });

  describe("review round 3: retired Builders, creation cap, durable fence, workspace paths", () => {
    it.effect(
      "a removed pair's Builder is stopped first, then retired for good, also after a restart",
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness();
          const pair = yield* h.pair();
          yield* delegate(h);
          assert.equal((yield* latest(h)).state, "running");
          yield* h.coordinator.service.removePair({ pairId: pair.id });
          // The durable Stop interrupted the Builder before the rows went.
          assert.isTrue(
            h.runtime.commands.some(
              (command) =>
                command.type === "thread.turn.interrupt" &&
                command.threadId === pair.builderThreadId &&
                command.commandId.startsWith(`helix:stop:${pair.id}:`),
            ),
          );
          const builder = pair.builderThreadId;
          assert.equal(h.profiles.get(builder)?.kind, "helix_retired");
          const refusal = (command: Record<string, unknown>) =>
            h.coordinator.hooks
              .interceptClientCommand({
                commandId: "c" as never,
                threadId: builder,
                ...command,
              } as unknown as OrchestrationCommand)
              .pipe(
                Effect.flip,
                Effect.map((error) => error.reason),
              );
          assert.equal(
            yield* refusal({
              type: "thread.turn.start",
              message: { messageId: "m", role: "user", text: "hi", attachments: [] },
              dispatchMode: "queue",
              runtimeMode: "approval-required",
              interactionMode: "default",
              createdAt: NOW,
            }),
            "builder_read_only",
          );
          assert.equal(yield* refusal({ type: "thread.unarchive" }), "builder_read_only");
          // Deleting it stays possible.
          yield* h.coordinator.hooks.interceptClientCommand({
            type: "thread.delete",
            commandId: "d" as never,
            threadId: builder,
          });
          assert.isFalse(
            yield* h.coordinator.hooks.shouldSendServerTurn({
              threadId: builder,
              messageId: "automation:x",
              dispatchOrigin: "automation",
            }),
          );
          // A restart re-applies the retirement from storage.
          const profiles = new Map<string, AgentGatewayRoleProfile | null>();
          const restarted = yield* makeHelixCoordinator({
            repository: h.repository,
            runtime: h.runtime.shape,
            isEnabled: Effect.succeed(true),
            setRoleProfile: (threadId, profile) => profiles.set(threadId, profile),
          });
          assert.equal(profiles.get(builder)?.kind, "helix_retired");
          assert.isTrue(restarted.hooks.roleOf(builder)?.retired);
          assert.isNull(restarted.hooks.roleOf(pair.leadThreadId));
        }),
    );

    it.effect(
      "Builder creation with an unknown outcome is capped, then abandoned visibly, with a frozen payload",
      () =>
        Effect.gen(function* () {
          const runtime = new FakeRuntime();
          runtime.unknownOutcomeTypes.add("thread.create");
          const h = yield* makeHarness({ runtime });
          const pair = yield* h.pair();
          yield* delegate(h);
          const lead = runtime.threads.get(pair.leadThreadId)!;
          for (let sweep = 0; sweep < 8; sweep += 1) {
            // The Lead is renamed between attempts: the retried command must not change.
            runtime.threads.set(pair.leadThreadId, { ...lead, title: `Renamed ${sweep}` });
            yield* h.coordinator.hooks.sweep();
          }
          const handoff = yield* latest(h);
          assert.equal(handoff.state, "failed");
          assert.include(handoff.failure?.reason ?? "", "could not be created after 5 attempts");
          const creates = runtime.attempted.filter((command) => command.type === "thread.create");
          assert.lengthOf(creates, 5);
          assert.lengthOf(new Set(creates.map((command) => JSON.stringify(command))), 1);
        }),
    );

    it.effect("a Stop that could not commit stays fenced across a restart until it commits", () =>
      Effect.gen(function* () {
        const base = yield* HelixRepository;
        let failCommits = false;
        const runtime = new FakeRuntime();
        const leadId = "lead-durable-fence";
        runtime.threads.set(leadId, shell(leadId));
        const repository: HelixRepositoryShape = {
          ...base,
          commit: (input) =>
            failCommits
              ? Effect.fail(new HelixRepositoryError({ code: "storage", message: "busy" }))
              : base.commit(input),
        };
        const deps = {
          repository,
          runtime: runtime.shape,
          isEnabled: Effect.succeed(true),
          setRoleProfile: () => {},
          newThreadId: () => ThreadId.makeUnsafe("builder-durable-fence"),
        };
        const coordinator = yield* makeHelixCoordinator(deps);
        yield* coordinator.service.enable({
          leadThreadId: ThreadId.makeUnsafe(leadId),
          builderModelSelection: codex,
        });
        yield* coordinator.port.delegate(
          {
            threadId: ThreadId.makeUnsafe(leadId),
            turnId: TurnId.makeUnsafe("lt"),
            sessionKey: "l",
            provider: "claudeAgent",
            role: "lead",
          },
          { requestId: "a", brief, waitSeconds: 0 },
        );
        const pair = (yield* base
          .getPairByLeadThread(ThreadId.makeUnsafe(leadId))
          .pipe(Effect.orDie))!;
        const handoff = (yield* base.listHandoffs(pair.id).pipe(Effect.orDie))[0]!;
        failCommits = true;
        yield* Effect.exit(coordinator.service.stop({ pairId: pair.id }));
        // The server restarts while commits still fail.
        const restarted = yield* makeHelixCoordinator(deps);
        const briefTurn = {
          threadId: pair.builderThreadId,
          messageId: handoff.dispatch!.messageId,
          dispatchOrigin: "agent",
        };
        assert.isFalse(yield* restarted.hooks.shouldSendServerTurn(briefTurn));
        failCommits = false;
        yield* restarted.hooks.sweep();
        assert.equal((yield* base.getPair(pair.id).pipe(Effect.orDie))!.hold?.kind, "stop");
        assert.lengthOf(yield* base.listStopRequests().pipe(Effect.orDie), 0);
      }),
    );

    it.effect("the workspace guard compares path segments and ignores unreadable other pairs", () =>
      Effect.gen(function* () {
        const runtime = new FakeRuntime();
        runtime.threads.set("lead-paths", shell("lead-paths", { worktreePath: "/repo" }));
        const h = yield* makeHarness({ runtime, leadId: "lead-paths" });
        assert.equal(
          (yield* flip(h.coordinator.hooks.assertMayMoveWorkspace("other", "/repo/sub"))).reason,
          "workspace_in_pair",
        );
        yield* h.coordinator.hooks.assertMayMoveWorkspace("other", "/repo-2");
        // A pair whose Lead cannot be read does not block unrelated directories.
        const failing = new FakeRuntime();
        failing.threads.set("lead-unreadable", shell("lead-unreadable", { worktreePath: "/x" }));
        const h2 = yield* makeHarness({ runtime: failing, leadId: "lead-unreadable" });
        failing.failGetThread = true;
        yield* h2.coordinator.hooks.assertMayMoveWorkspace("other", "/elsewhere");
      }),
    );
  });

  describe("a Helix pairing riding on a user message", () => {
    const send = (
      h: { coordinator: HelixCoordinator },
      threadId: string,
      messageId: string,
      helix?: unknown,
      dispatchMode: "queue" | "steer" = "queue",
    ) =>
      h.coordinator.hooks.interceptClientCommand({
        type: "thread.turn.start",
        commandId: `c-${messageId}` as never,
        threadId: ThreadId.makeUnsafe(threadId),
        message: { messageId: messageId as never, role: "user", text: "hi", attachments: [] },
        dispatchMode,
        runtimeMode: "approval-required",
        interactionMode: "default",
        ...(helix === undefined ? {} : { helix }),
        createdAt: NOW,
      } as unknown as OrchestrationCommand);
    const off = { enabled: false };
    const gpt55 = Schema.decodeSync(ModelSelection)({ provider: "codex", model: "gpt-5.5" });

    it.effect("turns Helix on for an ordinary chat before the message's turn, once", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ enable: false });
        const leadId = h.lead.threadId;
        const sent = yield* send(h, leadId, "m-on", on());
        assert.deepStrictEqual(sent.pairing, { status: "applied" });
        // Planned, not applied, until the engine accepted the message.
        assert.isNull(h.coordinator.hooks.roleOf(leadId));
        // The reactor waits for the pairing; afterAccepted releases it.
        const waiting = yield* h.coordinator.hooks
          .awaitMessagePairing(leadId, "m-on")
          .pipe(Effect.forkChild);
        yield* sent.afterAccepted;
        yield* Fiber.join(waiting);
        assert.equal(h.coordinator.hooks.roleOf(leadId)?.role, "lead");
        assert.equal(h.profiles.get(leadId)?.kind, "helix_lead");
        assert.equal((yield* h.coordinator.hooks.sessionRoleFor(leadId))?.role, "lead");
        const pair = yield* h.pair();
        assert.deepStrictEqual(pair.config.builderModelSelection, codex);
        // The same message retried applies nothing again.
        const revision = pair.revision;
        yield* (yield* send(h, leadId, "m-on", on(gpt55))).afterAccepted;
        assert.equal((yield* h.pair()).revision, revision);
      }),
    );

    it.effect("a message that is not accepted applies nothing and releases the reactor", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ enable: false });
        const sent = yield* send(h, h.lead.threadId, "m-rejected", on());
        yield* sent.cancel!;
        yield* h.coordinator.hooks.awaitMessagePairing(h.lead.threadId, "m-rejected");
        assert.isNull(h.coordinator.hooks.roleOf(h.lead.threadId));
        // An old client (no field) is untouched.
        const plain = yield* send(h, h.lead.threadId, "m-plain");
        assert.isUndefined(plain.pairing);
        yield* plain.afterAccepted;
        assert.isNull(h.coordinator.hooks.roleOf(h.lead.threadId));
      }),
    );

    it.effect("an ineligible chat still sends; Helix is not applied, with a typed reason", () =>
      Effect.gen(function* () {
        const runtime = new FakeRuntime();
        runtime.threads.set(
          "lead-sub",
          shell("lead-sub", { parentThreadId: ThreadId.makeUnsafe("parent") }),
        );
        const h = yield* makeHarness({ runtime, leadId: "lead-sub", enable: false });
        const sub = yield* send(h, "lead-sub", "m-sub", on());
        assert.equal(sub.pairing?.status, "not_applied");
        assert.equal(sub.pairing?.reason, "unsupported_thread");
        yield* sub.afterAccepted;
        assert.isNull(h.coordinator.hooks.roleOf("lead-sub"));

        const h2 = yield* makeHarness({ enable: false });
        yield* Ref.set(h2.enabled, false);
        const offSetting = yield* send(h2, h2.lead.threadId, "m-setting", on());
        assert.equal(offSetting.pairing?.reason, "setting_off");
        yield* Ref.set(h2.enabled, true);
        const badBuilder = yield* send(
          h2,
          h2.lead.threadId,
          "m-cursor",
          on(Schema.decodeSync(ModelSelection)({ provider: "cursor", model: "x" })),
        );
        assert.equal(badBuilder.pairing?.reason, "unsupported_builder_provider");
      }),
    );

    it.effect("a Builder change while a handoff runs is pending, then applied at idle", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* delegate(h);
        // Queued or steered, the change rides on the message and is kept.
        const steered = yield* send(h, h.lead.threadId, "m-change", on(gpt55), "steer");
        assert.deepStrictEqual(steered.pairing, { status: "pending" });
        yield* steered.afterAccepted;
        const pending = yield* h.pair();
        assert.deepStrictEqual(pending.config.pendingChange, {
          kind: "builder",
          builderModelSelection: gpt55,
        });
        assert.deepStrictEqual(pending.config.builderModelSelection, codex);
        // Still busy: the sweep keeps it pending.
        yield* h.coordinator.hooks.sweep();
        assert.isNotNull((yield* h.pair()).config.pendingChange);
        yield* completeLatestBrief(h, "b-1");
        yield* h.coordinator.port.review(h.lead, {
          handoffId: (yield* latest(h)).id,
          requestId: "ok",
          verdict: "accepted",
          waitSeconds: 0,
        });
        const applied = yield* h.pair();
        assert.isNull(applied.config.pendingChange ?? null);
        assert.deepStrictEqual(applied.config.builderModelSelection, gpt55);
        // The next brief uses it.
        yield* delegate(h, "second");
        const second = h.runtime.turnStarts(applied.builderThreadId)[1];
        assert.deepStrictEqual(
          second?.type === "thread.turn.start" ? second.modelSelection : null,
          gpt55,
        );
      }),
    );

    it.effect("Helix off while running waits for idle; the Lead is ordinary afterwards", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* delegate(h);
        const sent = yield* send(h, h.lead.threadId, "m-off", off);
        assert.deepStrictEqual(sent.pairing, { status: "pending" });
        yield* sent.afterAccepted;
        assert.equal((yield* h.pair()).lifecycle, "active");
        assert.deepStrictEqual((yield* h.pair()).config.pendingChange, { kind: "disable" });
        // The running brief keeps going.
        const handoff = yield* latest(h);
        assert.isTrue(
          yield* h.coordinator.hooks.shouldSendServerTurn({
            threadId: (yield* h.pair()).builderThreadId,
            messageId: handoff.dispatch!.messageId,
            dispatchOrigin: "agent",
          }),
        );
        yield* completeLatestBrief(h, "b-1");
        yield* h.coordinator.port.review(h.lead, {
          handoffId: handoff.id,
          requestId: "ok",
          verdict: "accepted",
          waitSeconds: 0,
        });
        assert.equal((yield* h.pair()).lifecycle, "disabled");
        assert.isNull(yield* h.coordinator.hooks.sessionRoleFor(h.lead.threadId));
        // Off again: already so.
        assert.deepStrictEqual((yield* send(h, h.lead.threadId, "m-off-2", off)).pairing, {
          status: "unchanged",
        });
      }),
    );

    it.effect(
      "on again with the current Builder cancels a pending change; re-enable after off",
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness();
          yield* delegate(h);
          yield* (yield* send(h, h.lead.threadId, "m-a", off)).afterAccepted;
          assert.isNotNull((yield* h.pair()).config.pendingChange);
          yield* (yield* send(h, h.lead.threadId, "m-b", on())).afterAccepted;
          assert.isNull((yield* h.pair()).config.pendingChange ?? null);

          const idle = yield* makeHarness();
          yield* (yield* send(idle, idle.lead.threadId, "m-c", off)).afterAccepted;
          assert.equal((yield* idle.pair()).lifecycle, "disabled");
          const back = yield* send(idle, idle.lead.threadId, "m-d", on(gpt55));
          assert.deepStrictEqual(back.pairing, { status: "applied" });
          yield* back.afterAccepted;
          const reenabled = yield* idle.pair();
          assert.equal(reenabled.lifecycle, "active");
          assert.deepStrictEqual(reenabled.config.builderModelSelection, gpt55);
        }),
    );
  });

  describe("message pairing: authority, order and durability", () => {
    const sendAs = (
      h: { coordinator: HelixCoordinator },
      threadId: string,
      messageId: string,
      helix: unknown,
      mayConfigureHelix: boolean,
    ) =>
      h.coordinator.hooks.interceptClientCommand(
        {
          type: "thread.turn.start",
          commandId: `c-${messageId}` as never,
          threadId: ThreadId.makeUnsafe(threadId),
          message: { messageId: messageId as never, role: "user", text: "hi", attachments: [] },
          dispatchMode: "queue",
          runtimeMode: "approval-required",
          interactionMode: "default",
          helix,
          createdAt: NOW,
        } as unknown as OrchestrationCommand,
        { mayConfigureHelix },
      );
    const gpt55 = Schema.decodeSync(ModelSelection)({ provider: "codex", model: "gpt-5.5" });

    it.effect("only the owner's message changes Helix; anyone else's still sends", () =>
      Effect.gen(function* () {
        // On, for a chat without a pair.
        const fresh = yield* makeHarness({ enable: false });
        const onAttempt = yield* sendAs(fresh, fresh.lead.threadId, "n-on", on(), false);
        assert.deepStrictEqual(onAttempt.pairing?.reason, "not_permitted");
        yield* onAttempt.afterAccepted;
        assert.isNull(fresh.coordinator.hooks.roleOf(fresh.lead.threadId));
        // Off and a Builder change, for an active pair.
        const h = yield* makeHarness();
        const before = yield* h.pair();
        for (const [id, helix] of [
          ["n-off", { enabled: false }],
          ["n-model", on(gpt55)],
        ] as const) {
          const attempt = yield* sendAs(h, h.lead.threadId, id, helix, false);
          assert.equal(attempt.pairing?.status, "not_applied");
          assert.equal(attempt.pairing?.reason, "not_permitted");
          yield* attempt.afterAccepted;
        }
        const after = yield* h.pair();
        assert.equal(after.lifecycle, "active");
        assert.deepStrictEqual(
          after.config.builderModelSelection,
          before.config.builderModelSelection,
        );
        assert.isNull(after.config.pendingChange ?? null);
        // The owner may.
        const owner = yield* sendAs(h, h.lead.threadId, "n-owner", on(gpt55), true);
        assert.equal(owner.pairing?.status, "applied");
        yield* owner.afterAccepted;
        assert.deepStrictEqual((yield* h.pair()).config.builderModelSelection, gpt55);
      }),
    );

    it.effect(
      "the reactor reaching the turn first applies the pairing; afterAccepted adds nothing",
      () =>
        Effect.gen(function* () {
          const h = yield* makeHarness({ enable: false });
          const leadId = h.lead.threadId;
          const sent = yield* sendAs(h, leadId, "r-first", on(), true);
          // The reactor gets the turn start before the RPC's afterAccepted ran.
          yield* h.coordinator.hooks.awaitMessagePairing(leadId, "r-first");
          assert.equal((yield* h.coordinator.hooks.sessionRoleFor(leadId))?.role, "lead");
          const revision = (yield* h.pair()).revision;
          yield* sent.afterAccepted;
          // Only the goal start was added.
          assert.isAtMost((yield* h.pair()).revision, revision + 1);
          // A message without a pairing takes no wait at all.
          const exit = yield* h.coordinator.hooks
            .awaitMessagePairing(leadId, "no-pairing")
            .pipe(Effect.timeoutOption(Duration.millis(0)));
          assert.equal(exit._tag, "Some");
        }),
    );

    it.effect("a pending off survives a later Builder change", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* delegate(h);
        yield* (yield* sendAs(h, h.lead.threadId, "p-off", { enabled: false }, true)).afterAccepted;
        assert.deepStrictEqual((yield* h.pair()).config.pendingChange, { kind: "disable" });
        // The helix.updateConfig RPC changing the Builder does not drop the pending "off".
        yield* completeLatestBrief(h, "b-1");
        const settled = yield* h.pair();
        const updated = yield* Effect.result(
          h.coordinator.service.updateConfig({
            pairId: settled.id,
            expectedRevision: settled.revision,
            builderModelSelection: gpt55,
          }),
        );
        // Busy (awaiting review): refused; either way the pending off is kept.
        assert.equal(updated._tag, "Failure");
        assert.deepStrictEqual((yield* h.pair()).config.pendingChange, { kind: "disable" });
      }),
    );
  });
});
