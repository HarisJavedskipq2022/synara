import {
  MessageId,
  ModelSelection,
  ProjectId,
  ThreadId,
  TurnId,
  type HelixBriefInput,
  type HelixHandoff,
  type HelixHandoffId,
  type HelixPair,
  type HelixPairId,
} from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  helixCorrectionRequestId,
  helixDispatchCommandId,
  helixWakeCommandId,
} from "./identity.ts";
import {
  createHelixPair,
  helixCorrectionCreated,
  HELIX_MAX_WAKE_ATTEMPTS,
  transitionHelix,
  type HelixAggregate,
  type HelixCommand,
  type HelixEffect,
  type HelixTransitionOk,
} from "./stateMachine.ts";

const NOW = "2026-11-12T10:00:00.000Z";
const LATER = "2026-11-12T10:05:00.000Z";
const lead = ThreadId.makeUnsafe("thread-lead");
const builder = ThreadId.makeUnsafe("thread-builder");
const pairId = "helix-pair:test" as HelixPairId;
const h = (n: number) => `helix-handoff:${n}` as HelixHandoffId;
const msg = (n: number) => MessageId.makeUnsafe(`message-${n}`);
const turn = (n: number) => TurnId.makeUnsafe(`turn-${n}`);
const codex = Schema.decodeSync(ModelSelection)({ provider: "codex", model: "gpt-5" });
const brief: HelixBriefInput = {
  title: "Add the login form",
  objective: "Implement the login form.",
  acceptanceCriteria: "Form validates and submits.",
};

function newPair(): HelixPair {
  const created = createHelixPair({
    pairId,
    projectId: ProjectId.makeUnsafe("project"),
    leadThreadId: lead,
    leadProvider: "claudeAgent",
    builderThreadId: builder,
    builderModelSelection: codex,
    builderRuntimeMode: "approval-required",
    now: NOW,
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.pair;
}

/** Applies commands in order, committing each change, like the coordinator does. */
class Harness {
  aggregate: HelixAggregate;
  constructor(pair: HelixPair = newPair()) {
    this.aggregate = { pair, handoffs: [] };
  }
  get pair() {
    return this.aggregate.pair;
  }
  handoff(id: HelixHandoffId): HelixHandoff {
    const found = this.aggregate.handoffs.find((handoff) => handoff.id === id);
    if (!found) throw new Error(`no handoff ${id}`);
    return found;
  }
  apply(command: HelixCommand): HelixTransitionOk {
    const result = transitionHelix(this.aggregate, command);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    this.commit(result);
    return result;
  }
  refuse(command: HelixCommand) {
    const result = transitionHelix(this.aggregate, command);
    if (result.ok) throw new Error(`expected a refusal for ${command.type}`);
    return result.error;
  }
  private commit(result: HelixTransitionOk) {
    if (!result.changed) return;
    expect(result.pair.revision).toBe(result.expectedRevision + 1);
    const byId = new Map(this.aggregate.handoffs.map((handoff) => [handoff.id, handoff]));
    for (const write of result.writes) {
      if (write.kind === "insert") {
        expect(byId.has(write.handoff.id)).toBe(false);
        expect(write.handoff.revision).toBe(0);
      } else {
        expect(byId.get(write.handoff.id)?.revision).toBe(write.expectedRevision);
        expect(write.handoff.revision).toBe(write.expectedRevision + 1);
      }
      byId.set(write.handoff.id, write.handoff);
    }
    this.aggregate = { pair: result.pair, handoffs: [...byId.values()] };
    const active = this.aggregate.handoffs.filter((handoff) =>
      ["prepared", "dispatching", "running"].includes(handoff.state),
    );
    expect(active.length).toBeLessThanOrEqual(1);
  }

  // Shortcuts for the happy path.
  delegate(n: number, requestId = `request-${n}`) {
    return this.apply({
      type: "delegate",
      handoffId: h(n),
      requestId,
      fingerprint: `fp-${requestId}`,
      brief,
      now: NOW,
    });
  }
  builderCreated() {
    return this.apply({ type: "builder.created", now: NOW });
  }
  dispatch(n: number) {
    this.apply({ type: "dispatch.start", handoffId: h(n), messageId: msg(n), now: NOW });
    const commandId = this.handoff(h(n)).dispatch!.commandId;
    return this.apply({
      type: "dispatch.acknowledged",
      handoffId: h(n),
      commandId,
      builderTurnId: turn(n),
      now: NOW,
    });
  }
  settle(n: number, outcome: "completed" | "failed" | "interrupted" = "completed") {
    return this.apply({
      type: "turn.settled",
      handoffId: h(n),
      builderTurnId: turn(n),
      turnOutcome: outcome,
      finalMessage: "Done.",
      now: LATER,
    });
  }
  review(n: number, verdict: "accepted" | "changes_requested" | "blocked", next: number) {
    return this.apply({
      type: "review",
      handoffId: h(n),
      requestId: `review-${n}`,
      verdict,
      feedback: verdict === "accepted" ? "" : `Fix ${n}`,
      nextHandoffId: h(next),
      nextFingerprint: `fp-correction-${n}`,
      now: LATER,
    });
  }
}

const effectTypes = (effects: ReadonlyArray<HelixEffect>) => effects.map((effect) => effect.type);

describe("createHelixPair", () => {
  it("creates an active pair at revision 0 with default limits", () => {
    const pair = newPair();
    expect(pair).toMatchObject({
      revision: 0,
      cancellationEpoch: 0,
      hold: null,
      lifecycle: "active",
      builderCreatedAt: null,
      goal: { seq: 0, dispatchCount: 0, dispatchBudget: 20 },
      config: { limits: { maxCorrectionsPerWorkItem: 3, maxDispatchesPerGoal: 20 } },
    });
  });

  it("refuses unsupported providers with a specific reason and never substitutes", () => {
    const opencode = Schema.decodeSync(ModelSelection)({ provider: "opencode", model: "x" });
    const result = createHelixPair({
      pairId,
      projectId: ProjectId.makeUnsafe("project"),
      leadThreadId: lead,
      leadProvider: "codex",
      builderThreadId: builder,
      builderModelSelection: opencode,
      builderRuntimeMode: "auto",
      now: NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("unsupported_provider");
      expect(result.error.message).toMatch(/^Unsupported in this version: OpenCode/);
    }
    const leadResult = createHelixPair({
      pairId,
      projectId: ProjectId.makeUnsafe("project"),
      leadThreadId: lead,
      leadProvider: "pi",
      builderThreadId: builder,
      builderModelSelection: codex,
      builderRuntimeMode: "auto",
      now: NOW,
    });
    expect(leadResult.ok).toBe(false);
  });

  it("refuses the same thread in both roles", () => {
    const result = createHelixPair({
      pairId,
      projectId: ProjectId.makeUnsafe("project"),
      leadThreadId: lead,
      leadProvider: "codex",
      builderThreadId: lead,
      builderModelSelection: codex,
      builderRuntimeMode: "auto",
      now: NOW,
    });
    expect(result.ok).toBe(false);
  });
});

describe("handoff lifecycle", () => {
  it("runs prepared → dispatching → running → awaiting_review → accepted", () => {
    const t = new Harness();
    const delegated = t.delegate(1);
    expect(delegated.handoff?.state).toBe("prepared");
    expect(delegated.effects).toEqual([
      { type: "dispatch_ready", handoffId: h(1), needsBuilderThread: true },
    ]);

    expect(
      t.refuse({ type: "dispatch.start", handoffId: h(1), messageId: msg(1), now: NOW }).code,
    ).toBe("builder_missing");
    t.builderCreated();

    const started = t.apply({
      type: "dispatch.start",
      handoffId: h(1),
      messageId: msg(1),
      now: NOW,
    });
    expect(started.handoff).toMatchObject({
      state: "dispatching",
      dispatchAttempts: 1,
      dispatch: { commandId: helixDispatchCommandId(h(1), 1), createdAt: NOW, attempt: 1 },
    });
    expect(t.pair.goal.dispatchCount).toBe(1);

    t.apply({
      type: "dispatch.acknowledged",
      handoffId: h(1),
      commandId: helixDispatchCommandId(h(1), 1),
      builderTurnId: turn(1),
      now: NOW,
    });
    expect(t.handoff(h(1)).state).toBe("running");

    const settled = t.settle(1);
    expect(settled.handoff).toMatchObject({
      state: "awaiting_review",
      delivery: "pending",
      result: { revision: 1, source: "final_message", outcome: "partial", summary: "Done." },
    });
    expect(settled.effects).toEqual([
      { type: "deliver_result", handoffId: h(1), wakeAllowed: true },
    ]);

    const accepted = t.review(1, "accepted", 2);
    expect(accepted.handoff).toMatchObject({
      state: "accepted",
      delivery: "acknowledged",
      review: { verdict: "accepted", reviewedResultRevision: 1, nextHandoffId: null },
    });
    expect(accepted.effects).toEqual([]);
  });

  it("prefers the Builder's report over its final message", () => {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    t.dispatch(1);
    t.apply({
      type: "report.submit",
      builderTurnId: turn(1),
      report: { outcome: "completed", summary: "Login form added", verification: "bun test" },
      now: NOW,
    });
    t.apply({
      type: "report.submit",
      builderTurnId: turn(1),
      report: { outcome: "completed", summary: "Login form added and tested" },
      now: NOW,
    });
    expect(t.handoff(h(1)).report?.reportRevision).toBe(2);
    const settled = t.settle(1);
    expect(settled.handoff?.result).toMatchObject({
      source: "report",
      outcome: "completed",
      summary: "Login form added and tested",
    });
  });

  it("reports a failed or interrupted Builder turn to the Lead", () => {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    t.dispatch(1);
    const failed = t.settle(1, "failed");
    expect(failed.handoff).toMatchObject({ state: "failed", delivery: "pending" });
    expect(failed.handoff?.result?.outcome).toBe("failed");
    expect(effectTypes(failed.effects)).toEqual(["deliver_result"]);
  });

  it("records dispatch failure and an uncertain send without ever resending", () => {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    t.apply({ type: "dispatch.start", handoffId: h(1), messageId: msg(1), now: NOW });
    const uncertain = t.apply({
      type: "dispatch.uncertain",
      handoffId: h(1),
      commandId: helixDispatchCommandId(h(1), 1),
      reason: "No acknowledgement",
      now: NOW,
    });
    expect(uncertain.handoff).toMatchObject({ state: "uncertain", delivery: "suppressed" });
    expect(t.pair.hold).toMatchObject({ kind: "uncertain", handoffId: h(1) });
    expect(uncertain.effects).toEqual([]);
    // The user must resume; a user message does not clear an uncertain hold.
    t.apply({ type: "user_message", messageId: msg(9), now: LATER });
    expect(t.pair.hold?.kind).toBe("uncertain");

    const other = new Harness();
    other.delegate(1);
    other.builderCreated();
    other.apply({ type: "dispatch.start", handoffId: h(1), messageId: msg(1), now: NOW });
    const failed = other.apply({
      type: "dispatch.failed",
      handoffId: h(1),
      commandId: helixDispatchCommandId(h(1), 1),
      reason: "Rejected",
      now: NOW,
    });
    expect(failed.handoff).toMatchObject({ state: "failed", delivery: "pending" });
  });

  it("returns a suppressed dispatch to prepared and dispatches a new attempt later", () => {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    t.apply({ type: "dispatch.start", handoffId: h(1), messageId: msg(1), now: NOW });
    t.apply({ type: "pause", expectedRevision: t.pair.revision, now: NOW });
    t.apply({
      type: "dispatch.suppressed",
      handoffId: h(1),
      commandId: helixDispatchCommandId(h(1), 1),
      now: NOW,
    });
    expect(t.handoff(h(1))).toMatchObject({
      state: "prepared",
      dispatch: null,
      dispatchAttempts: 1,
    });
    expect(t.pair.goal.dispatchCount).toBe(0);
    const resumed = t.apply({ type: "resume", expectedRevision: t.pair.revision, now: NOW });
    expect(resumed.effects).toEqual([
      { type: "dispatch_ready", handoffId: h(1), needsBuilderThread: false },
    ]);
    t.apply({ type: "dispatch.start", handoffId: h(1), messageId: msg(2), now: LATER });
    expect(t.handoff(h(1)).dispatch?.commandId).toBe(helixDispatchCommandId(h(1), 2));
    expect(t.handoff(h(1)).dispatch?.createdAt).toBe(LATER);
  });

  it("refuses invalid transitions", () => {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    expect(
      t.refuse({
        type: "turn.settled",
        handoffId: h(1),
        builderTurnId: null,
        turnOutcome: "completed",
        finalMessage: null,
        now: NOW,
      }).code,
    ).toBe("invalid_transition");
    expect(t.refuse({ type: "result.returned", handoffId: h(1), now: NOW }).code).toBe(
      "invalid_transition",
    );
    expect(
      t.refuse({ type: "wake.request", handoffId: h(1), messageId: msg(1), now: NOW }).code,
    ).toBe("invalid_transition");
    expect(t.refuse({ ...reviewCommand(1, "accepted") }).code).toBe("invalid_transition");
    expect(
      t.refuse({ type: "dispatch.start", handoffId: h(7), messageId: msg(1), now: NOW }).code,
    ).toBe("handoff_not_found");
    t.dispatch(1);
    expect(
      t.refuse({ type: "dispatch.start", handoffId: h(1), messageId: msg(1), now: NOW }).code,
    ).toBe("invalid_transition");
    expect(
      t.refuse({
        type: "dispatch.acknowledged",
        handoffId: h(1),
        commandId: "helix:dispatch:other:1",
        builderTurnId: null,
        now: NOW,
      }).code,
    ).toBe("command_mismatch");
    expect(
      t.refuse({
        type: "turn.settled",
        handoffId: h(1),
        builderTurnId: turn(99),
        turnOutcome: "completed",
        finalMessage: null,
        now: NOW,
      }).code,
    ).toBe("turn_mismatch");
    expect(
      t.refuse({
        type: "report.submit",
        builderTurnId: turn(99),
        report: { outcome: "completed", summary: "x" },
        now: NOW,
      }).code,
    ).toBe("turn_mismatch");
    t.settle(1);
    expect(t.refuse({ ...reviewCommand(1, "changes_requested"), feedback: "  " }).code).toBe(
      "feedback_required",
    );
    expect(t.refuse({ ...reviewCommand(1, "accepted"), expectedResultRevision: 2 }).code).toBe(
      "stale_result",
    );
    expect(
      t.refuse({
        type: "report.submit",
        builderTurnId: null,
        report: { outcome: "completed", summary: "late" },
        now: NOW,
      }).code,
    ).toBe("no_running_handoff");
  });

  it("treats repeated acknowledgements and settlements as no-ops", () => {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    t.dispatch(1);
    const ack = transitionHelix(t.aggregate, {
      type: "dispatch.acknowledged",
      handoffId: h(1),
      commandId: helixDispatchCommandId(h(1), 1),
      builderTurnId: turn(1),
      now: NOW,
    });
    expect(ack.ok && ack.changed).toBe(false);
    t.settle(1);
    const again = transitionHelix(t.aggregate, {
      type: "turn.settled",
      handoffId: h(1),
      builderTurnId: turn(1),
      turnOutcome: "completed",
      finalMessage: "Done.",
      now: LATER,
    });
    expect(again.ok && again.changed).toBe(false);
  });
});

function reviewCommand(
  n: number,
  verdict: "accepted" | "changes_requested" | "blocked",
): Extract<HelixCommand, { type: "review" }> {
  return {
    type: "review",
    handoffId: h(n),
    requestId: `review-${n}`,
    verdict,
    feedback: verdict === "accepted" ? "" : `Fix ${n}`,
    nextHandoffId: h(n + 100),
    nextFingerprint: `fp-correction-${n}`,
    now: LATER,
  };
}

describe("delegation guards and request identity", () => {
  it("replays an identical request and refuses the same id with different content", () => {
    const t = new Harness();
    t.delegate(1);
    const replay = transitionHelix(t.aggregate, {
      type: "delegate",
      handoffId: h(2),
      requestId: "request-1",
      fingerprint: "fp-request-1",
      brief,
      now: LATER,
    });
    expect(replay).toMatchObject({ ok: true, changed: false, replayed: true });
    expect(replay.ok && replay.handoff?.id).toBe(h(1));
    const conflict = t.refuse({
      type: "delegate",
      handoffId: h(2),
      requestId: "request-1",
      fingerprint: "different",
      brief,
      now: LATER,
    });
    expect(conflict).toMatchObject({ code: "request_conflict", handoffId: h(1) });
  });

  it("allows one active handoff and requires a review before new work", () => {
    const t = new Harness();
    t.delegate(1);
    expect(t.refuse(delegateCommand(2)).code).toBe("handoff_active");
    t.builderCreated();
    t.dispatch(1);
    expect(t.refuse(delegateCommand(2)).code).toBe("handoff_active");
    t.settle(1);
    expect(t.refuse(delegateCommand(2))).toMatchObject({ code: "review_pending", handoffId: h(1) });
    t.review(1, "accepted", 99);
    expect(t.delegate(2).handoff?.state).toBe("prepared");
  });

  it("lets new work start after a failed handoff without a review", () => {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    t.dispatch(1);
    t.settle(1, "failed");
    expect(t.delegate(2).handoff?.sequence).toBe(2);
  });

  it("refuses delegation under any hold or when disabled", () => {
    const t = new Harness();
    t.apply({ type: "pause", expectedRevision: 0, now: NOW });
    expect(t.refuse(delegateCommand(1))).toMatchObject({
      code: "pair_held",
      hold: { kind: "pause" },
    });
    t.apply({ type: "resume", expectedRevision: t.pair.revision, now: NOW });
    t.apply({ type: "disable", expectedRevision: t.pair.revision, now: NOW });
    expect(t.refuse(delegateCommand(1)).code).toBe("pair_disabled");
  });
});

function delegateCommand(n: number): HelixCommand {
  return {
    type: "delegate",
    handoffId: h(n),
    requestId: `request-${n}`,
    fingerprint: `fp-request-${n}`,
    brief,
    now: NOW,
  };
}

describe("corrections", () => {
  it("creates the next handoff linked to the reviewed result in the same work item", () => {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    t.dispatch(1);
    t.settle(1);
    const reviewed = t.review(1, "changes_requested", 2);
    expect(reviewed.handoff).toMatchObject({
      state: "changes_requested",
      review: { verdict: "changes_requested", nextHandoffId: h(2), feedback: "Fix 1" },
    });
    const next = helixCorrectionCreated(reviewed);
    expect(next).toMatchObject({
      id: h(2),
      state: "prepared",
      requestId: helixCorrectionRequestId(h(1)),
      workItemId: h(1),
      previousHandoffId: h(1),
      correctionIndex: 1,
      brief: {
        correction: { previousHandoffId: h(1), previousResultRevision: 1, feedback: "Fix 1" },
      },
    });
    expect(reviewed.effects).toEqual([
      { type: "dispatch_ready", handoffId: h(2), needsBuilderThread: false },
    ]);
  });

  it("replays an identical review and refuses a conflicting one", () => {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    t.dispatch(1);
    t.settle(1);
    t.review(1, "changes_requested", 2);
    const replay = transitionHelix(t.aggregate, reviewCommand(1, "changes_requested"));
    expect(replay).toMatchObject({ ok: true, changed: false, replayed: true });
    expect(t.refuse({ ...reviewCommand(1, "blocked") }).code).toBe("request_conflict");
    expect(t.refuse({ ...reviewCommand(1, "blocked"), requestId: "other" }).code).toBe(
      "invalid_transition",
    );
  });

  it("pauses dispatch after three corrections of one work item, and Resume allows one more", () => {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    let current = 1;
    for (let round = 1; round <= 3; round += 1) {
      t.dispatch(current);
      t.settle(current);
      const reviewed = t.review(current, "changes_requested", current + 1);
      expect(effectTypes(reviewed.effects)).toEqual(["dispatch_ready"]);
      current += 1;
    }
    t.dispatch(current);
    t.settle(current);
    const fourth = t.review(current, "changes_requested", current + 1);
    expect(fourth.effects).toEqual([]);
    expect(helixCorrectionCreated(fourth)?.correctionIndex).toBe(4);
    expect(t.pair.hold).toMatchObject({
      kind: "limit",
      limit: "work_item_corrections",
      handoffId: h(current + 1),
    });
    expect(
      t.refuse({ type: "dispatch.start", handoffId: h(current + 1), messageId: msg(1), now: NOW })
        .code,
    ).toBe("pair_held");
    const resumed = t.apply({ type: "resume", expectedRevision: t.pair.revision, now: NOW });
    expect(resumed.effects).toEqual([
      { type: "dispatch_ready", handoffId: h(current + 1), needsBuilderThread: false },
    ]);
  });

  it("pauses after twenty dispatches in one goal; Resume extends and a new goal resets", () => {
    const t = new Harness();
    t.builderCreated();
    for (let n = 1; n <= 20; n += 1) {
      t.delegate(n);
      t.dispatch(n);
      t.settle(n);
      t.review(n, "accepted", 1_000 + n);
    }
    expect(t.pair.goal.dispatchCount).toBe(20);
    const capped = t.delegate(21);
    expect(capped.handoff?.state).toBe("prepared");
    expect(capped.effects).toEqual([]);
    expect(t.pair.hold).toMatchObject({
      kind: "limit",
      limit: "goal_dispatches",
      handoffId: h(21),
    });

    const resumed = t.apply({ type: "resume", expectedRevision: t.pair.revision, now: NOW });
    expect(t.pair.goal.dispatchBudget).toBe(40);
    expect(effectTypes(resumed.effects)).toEqual(["dispatch_ready"]);

    t.dispatch(21);
    t.settle(21);
    t.review(21, "accepted", 2_000);
    t.apply({ type: "user_message", messageId: msg(1), now: LATER });
    expect(t.pair.goal).toMatchObject({ seq: 1, dispatchCount: 0, dispatchBudget: 20 });
  });
});

describe("Stop, the cancellation epoch and late results", () => {
  function runningPair() {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    t.dispatch(1);
    return t;
  }

  it("bumps the epoch, holds the pair, interrupts both threads and cancels waits", () => {
    const t = runningPair();
    const stopped = t.apply({ type: "stop", now: LATER });
    expect(t.pair.cancellationEpoch).toBe(1);
    expect(t.pair.hold).toMatchObject({ kind: "stop", epoch: 1 });
    expect(t.handoff(h(1))).toMatchObject({ state: "interrupted", delivery: "suppressed" });
    expect(stopped.effects).toEqual([
      {
        type: "interrupt_participants",
        leadThreadId: lead,
        builderThreadId: builder,
        builderHadWork: true,
      },
      { type: "cancel_waits", epoch: 1 },
    ]);
  });

  it("cancels prepared work and suppresses undelivered results", () => {
    const prepared = new Harness();
    prepared.delegate(1);
    prepared.apply({ type: "stop", now: LATER });
    expect(prepared.handoff(h(1)).state).toBe("cancelled");

    const pending = runningPair();
    pending.settle(1);
    expect(pending.handoff(h(1)).delivery).toBe("pending");
    pending.apply({ type: "stop", now: LATER });
    expect(pending.handoff(h(1))).toMatchObject({
      state: "awaiting_review",
      delivery: "suppressed",
    });
  });

  it("keeps a late result inspectable and never delivers or redispatches it", () => {
    const t = runningPair();
    t.apply({
      type: "report.submit",
      builderTurnId: turn(1),
      report: { outcome: "completed", summary: "Finished anyway" },
      now: NOW,
    });
    t.apply({ type: "stop", now: LATER });
    const late = t.settle(1);
    expect(late.effects).toEqual([]);
    expect(t.handoff(h(1))).toMatchObject({
      state: "interrupted",
      delivery: "suppressed",
      result: null,
      lateResult: { summary: "Finished anyway", source: "report" },
    });
    expect(
      t.refuse({ type: "wake.request", handoffId: h(1), messageId: msg(1), now: NOW }).code,
    ).toBe("invalid_transition");
    // A late report after Stop is refused.
    expect(
      t.refuse({
        type: "report.submit",
        builderTurnId: turn(1),
        report: { outcome: "completed", summary: "again" },
        now: NOW,
      }).code,
    ).toBe("no_running_handoff");
    // Resume does not resurrect it.
    const resumed = t.apply({ type: "resume", expectedRevision: t.pair.revision, now: NOW });
    expect(resumed.effects).toEqual([]);
  });

  it("drops a pre-Stop wake that is suppressed after Stop", () => {
    const t = runningPair();
    t.settle(1);
    t.apply({ type: "wake.request", handoffId: h(1), messageId: msg(5), now: NOW });
    const commandId = t.handoff(h(1)).wake!.commandId;
    expect(commandId).toBe(helixWakeCommandId(h(1), 1));
    t.apply({ type: "stop", now: LATER });
    expect(t.handoff(h(1)).delivery).toBe("suppressed");
    t.apply({ type: "wake.suppressed", handoffId: h(1), commandId, now: LATER });
    expect(t.handoff(h(1)).delivery).toBe("suppressed");
  });

  it("is released by Resume or by a user-origin message, which starts a new goal", () => {
    const resumeHarness = runningPair();
    resumeHarness.apply({ type: "stop", now: LATER });
    resumeHarness.apply({
      type: "resume",
      expectedRevision: resumeHarness.pair.revision,
      now: LATER,
    });
    expect(resumeHarness.pair.hold).toBeNull();
    expect(resumeHarness.pair.cancellationEpoch).toBe(1);

    const messageHarness = runningPair();
    messageHarness.apply({ type: "stop", now: LATER });
    messageHarness.apply({ type: "user_message", messageId: msg(2), now: LATER });
    expect(messageHarness.pair.hold).toBeNull();
    expect(messageHarness.pair.goal.seq).toBe(1);
    // New work after the release belongs to the new epoch and dispatches normally.
    const next = messageHarness.delegate(2);
    expect(next.handoff?.epoch).toBe(1);
    expect(effectTypes(next.effects)).toEqual(["dispatch_ready"]);
  });

  it("never emits dispatch or wake for work from an older epoch", () => {
    const t = new Harness();
    t.builderCreated();
    t.delegate(1);
    const stale: HelixAggregate = {
      pair: { ...t.pair, cancellationEpoch: t.pair.cancellationEpoch + 1 },
      handoffs: t.aggregate.handoffs,
    };
    const start = transitionHelix(stale, {
      type: "dispatch.start",
      handoffId: h(1),
      messageId: msg(1),
      now: NOW,
    });
    expect(start.ok ? null : start.error.code).toBe("stale_epoch");
  });

  it("does not let a pause or a later wake bypass the hold", () => {
    const t = runningPair();
    t.apply({ type: "pause", expectedRevision: t.pair.revision, now: NOW });
    const settled = t.settle(1);
    expect(settled.effects).toEqual([
      { type: "deliver_result", handoffId: h(1), wakeAllowed: false },
    ]);
    expect(
      t.refuse({ type: "wake.request", handoffId: h(1), messageId: msg(1), now: NOW }).code,
    ).toBe("pair_held");
    // A blocked Lead tool call may still receive it in-tool.
    t.apply({ type: "result.returned", handoffId: h(1), now: NOW });
    expect(t.handoff(h(1)).delivery).toBe("returned_in_tool");
    expect(
      t.refuse({ type: "wake.request", handoffId: h(1), messageId: msg(1), now: NOW }).code,
    ).toBe("invalid_transition");
  });

  it("records a wake the reactor dropped after accepting it", () => {
    const t = runningPair();
    t.settle(1);
    t.apply({ type: "wake.request", handoffId: h(1), messageId: msg(5), now: NOW });
    const commandId = t.handoff(h(1)).wake!.commandId;
    t.apply({ type: "wake.dispatched", handoffId: h(1), commandId, now: NOW });
    t.apply({ type: "pause", expectedRevision: t.pair.revision, now: NOW });
    t.apply({ type: "wake.suppressed", handoffId: h(1), commandId, now: NOW });
    expect(t.handoff(h(1))).toMatchObject({ delivery: "pending", wake: null });
    const resumed = t.apply({ type: "resume", expectedRevision: t.pair.revision, now: NOW });
    expect(resumed.effects).toEqual([
      { type: "deliver_result", handoffId: h(1), wakeAllowed: true, afterResume: true },
    ]);
  });

  it("delivers a held result exactly once after Resume", () => {
    const t = runningPair();
    t.apply({ type: "pause", expectedRevision: t.pair.revision, now: NOW });
    t.settle(1);
    const resumed = t.apply({ type: "resume", expectedRevision: t.pair.revision, now: NOW });
    expect(resumed.effects).toEqual([
      { type: "deliver_result", handoffId: h(1), wakeAllowed: true, afterResume: true },
    ]);
    t.apply({ type: "wake.request", handoffId: h(1), messageId: msg(7), now: NOW });
    const commandId = t.handoff(h(1)).wake!.commandId;
    t.apply({ type: "wake.dispatched", handoffId: h(1), commandId, now: NOW });
    expect(t.handoff(h(1)).delivery).toBe("wake_dispatched");
    expect(
      t.refuse({ type: "wake.request", handoffId: h(1), messageId: msg(8), now: NOW }).code,
    ).toBe("invalid_transition");
    expect(t.refuse({ type: "result.returned", handoffId: h(1), now: NOW }).code).toBe(
      "invalid_transition",
    );
  });
});

describe("controls and revisions", () => {
  it("refuses stale revisions on pause, resume, disable, enable and config", () => {
    const t = new Harness();
    for (const type of ["pause", "resume", "disable", "enable"] as const) {
      expect(t.refuse({ type, expectedRevision: 41, now: NOW }).code).toBe("stale_revision");
    }
    expect(t.refuse({ type: "config.update", expectedRevision: 41, now: NOW }).code).toBe(
      "stale_revision",
    );
  });

  it("Stop needs no revision and is idempotent on a disabled pair", () => {
    const t = new Harness();
    t.apply({ type: "stop", now: NOW });
    t.apply({ type: "stop", now: LATER });
    expect(t.pair.cancellationEpoch).toBe(2);
    t.apply({ type: "resume", expectedRevision: t.pair.revision, now: NOW });
    t.apply({ type: "disable", expectedRevision: t.pair.revision, now: NOW });
    const stopped = transitionHelix(t.aggregate, { type: "stop", now: NOW });
    expect(stopped.ok && stopped.changed).toBe(false);
  });

  it("resume without a hold and pause over another hold are refused", () => {
    const t = new Harness();
    expect(t.refuse({ type: "resume", expectedRevision: 0, now: NOW }).code).toBe("not_held");
    t.apply({ type: "stop", now: NOW });
    expect(t.refuse({ type: "pause", expectedRevision: t.pair.revision, now: NOW }).code).toBe(
      "pair_held",
    );
  });

  it("disables only an idle pair, suppresses deliveries, and re-enables", () => {
    const t = new Harness();
    t.delegate(1);
    expect(t.refuse({ type: "disable", expectedRevision: t.pair.revision, now: NOW }).code).toBe(
      "handoff_active",
    );
    t.builderCreated();
    t.dispatch(1);
    t.settle(1);
    const disabled = t.apply({ type: "disable", expectedRevision: t.pair.revision, now: NOW });
    expect(t.pair).toMatchObject({ lifecycle: "disabled", cancellationEpoch: 1, hold: null });
    expect(t.handoff(h(1)).delivery).toBe("suppressed");
    expect(effectTypes(disabled.effects)).toEqual([
      "cancel_waits",
      "archive_builder_thread",
      "update_role_profiles",
    ]);
    // A user message to a disabled pair's Lead changes nothing.
    const message = transitionHelix(t.aggregate, {
      type: "user_message",
      messageId: msg(1),
      now: NOW,
    });
    expect(message.ok && message.changed).toBe(false);
    const enabled = t.apply({ type: "enable", expectedRevision: t.pair.revision, now: NOW });
    expect(t.pair.lifecycle).toBe("active");
    expect(effectTypes(enabled.effects)).toEqual([
      "unarchive_builder_thread",
      "update_role_profiles",
    ]);
  });

  it("changes configuration only while idle and never accepts an unsupported Builder", () => {
    const t = new Harness();
    const claude = Schema.decodeSync(ModelSelection)({ provider: "claudeAgent", model: "sonnet" });
    const updated = t.apply({
      type: "config.update",
      expectedRevision: 0,
      builderModelSelection: claude,
      now: NOW,
    });
    expect(t.pair.config.builderModelSelection.provider).toBe("claudeAgent");
    expect(effectTypes(updated.effects)).toEqual(["restart_builder_session"]);
    const cursor = Schema.decodeSync(ModelSelection)({ provider: "cursor", model: "auto" });
    expect(
      t.refuse({
        type: "config.update",
        expectedRevision: t.pair.revision,
        builderModelSelection: cursor,
        now: NOW,
      }).code,
    ).toBe("unsupported_provider");
    t.delegate(1);
    expect(
      t.refuse({
        type: "config.update",
        expectedRevision: t.pair.revision,
        limits: { maxCorrectionsPerWorkItem: 1, maxDispatchesPerGoal: 5 },
        now: NOW,
      }).code,
    ).toBe("handoff_active");
  });

  it("a user message cancels work prepared for an earlier goal", () => {
    const t = new Harness();
    t.apply({ type: "pause", expectedRevision: 0, now: NOW });
    t.apply({ type: "resume", expectedRevision: t.pair.revision, now: NOW });
    t.delegate(1);
    t.apply({ type: "user_message", messageId: msg(1), now: LATER });
    expect(t.handoff(h(1)).state).toBe("cancelled");
  });
});

describe("restart reconciliation", () => {
  it("holds the pair, never redispatches, and classifies each unresolved handoff", () => {
    const evidence = new Map([[h(1), "not_sent" as const]]);
    const notSent = new Harness();
    notSent.delegate(1);
    notSent.builderCreated();
    notSent.apply({ type: "dispatch.start", handoffId: h(1), messageId: msg(1), now: NOW });
    const reconciled = notSent.apply({ type: "restart.reconcile", evidence, now: LATER });
    expect(reconciled.effects).toEqual([]);
    expect(notSent.handoff(h(1))).toMatchObject({ state: "prepared", dispatch: null });
    expect(notSent.pair.hold?.kind).toBe("restart");

    const uncertain = new Harness();
    uncertain.delegate(1);
    uncertain.builderCreated();
    uncertain.apply({ type: "dispatch.start", handoffId: h(1), messageId: msg(1), now: NOW });
    uncertain.apply({ type: "restart.reconcile", evidence: new Map(), now: LATER });
    expect(uncertain.handoff(h(1))).toMatchObject({ state: "uncertain", delivery: "suppressed" });
    expect(uncertain.pair.hold?.kind).toBe("uncertain");

    const running = new Harness();
    running.delegate(1);
    running.builderCreated();
    running.dispatch(1);
    running.apply({ type: "restart.reconcile", evidence: new Map(), now: LATER });
    // Still running: its turn may settle once ingestion catches up.
    expect(running.handoff(h(1))).toMatchObject({ state: "running", delivery: "none" });
    expect(running.pair.hold?.kind).toBe("restart");
    // It settles while held: the real result is kept and delivered on Resume.
    const settled = running.settle(1);
    expect(settled.effects).toEqual([
      { type: "deliver_result", handoffId: h(1), wakeAllowed: false },
    ]);
    expect(running.handoff(h(1))).toMatchObject({ state: "awaiting_review", delivery: "pending" });
    const resumed = running.apply({
      type: "resume",
      expectedRevision: running.pair.revision,
      now: LATER,
    });
    expect(resumed.effects).toEqual([
      { type: "deliver_result", handoffId: h(1), wakeAllowed: true, afterResume: true },
    ]);

    // A dispatching handoff whose turn exists becomes running, not interrupted.
    const started = new Harness();
    started.delegate(1);
    started.builderCreated();
    started.apply({ type: "dispatch.start", handoffId: h(1), messageId: msg(1), now: NOW });
    started.apply({
      type: "restart.reconcile",
      evidence: new Map([[h(1), "turn_started" as const]]),
      now: LATER,
    });
    expect(started.handoff(h(1)).state).toBe("running");
  });

  it("does not let a report from another turn claim the handoff", () => {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    t.apply({ type: "dispatch.start", handoffId: h(1), messageId: msg(1), now: NOW });
    t.apply({
      type: "dispatch.acknowledged",
      handoffId: h(1),
      commandId: helixDispatchCommandId(h(1), 1),
      builderTurnId: null,
      now: NOW,
    });
    t.apply({
      type: "report.submit",
      builderTurnId: turn(42),
      report: { outcome: "completed", summary: "stale" },
      now: NOW,
    });
    expect(t.handoff(h(1)).builderTurnId).toBeNull();
    const settled = t.apply({
      type: "turn.settled",
      handoffId: h(1),
      builderTurnId: turn(1),
      turnOutcome: "completed",
      finalMessage: "real",
      now: LATER,
    });
    expect(settled.handoff?.result).toMatchObject({ source: "final_message", summary: "real" });
  });

  it("fails a handoff whose brief could not be handed to the engine", () => {
    const t = new Harness();
    t.delegate(1);
    const abandoned = t.apply({
      type: "dispatch.abandoned",
      handoffId: h(1),
      reason: "Builder thread refused",
      now: NOW,
    });
    expect(t.handoff(h(1))).toMatchObject({ state: "failed", delivery: "pending" });
    expect(abandoned.effects.map((effect) => effect.type)).toEqual(["deliver_result"]);
  });

  it("labels a late result with why it was not delivered", () => {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    t.dispatch(1);
    t.apply({ type: "stop", now: NOW });
    t.settle(1);
    expect(t.handoff(h(1)).lateResultReason).toBe("stop");
  });

  it("leaves a stopped pair stopped and an idle pair untouched", () => {
    const stopped = new Harness();
    stopped.delegate(1);
    stopped.builderCreated();
    stopped.dispatch(1);
    stopped.apply({ type: "stop", now: NOW });
    stopped.apply({ type: "restart.reconcile", evidence: new Map(), now: LATER });
    expect(stopped.pair.hold?.kind).toBe("stop");

    const idle = new Harness();
    const result = transitionHelix(idle.aggregate, {
      type: "restart.reconcile",
      evidence: new Map(),
      now: LATER,
    });
    expect(result.ok && result.changed).toBe(false);
  });
});

describe("delivery is closed by review and never re-armed without bound", () => {
  const wakeFor = (t: Harness, n: number) => {
    t.apply({ type: "wake.request", handoffId: h(n), messageId: msg(50 + n), now: NOW });
    return t.handoff(h(n)).wake!.commandId;
  };
  const settled = () => {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    t.dispatch(1);
    t.settle(1);
    return t;
  };

  it("a review closes a requested or dispatched wake, and a later suppression stays closed", () => {
    for (const dispatched of [false, true]) {
      const t = settled();
      const commandId = wakeFor(t, 1);
      if (dispatched) {
        t.apply({ type: "wake.dispatched", handoffId: h(1), commandId, now: NOW });
      }
      t.review(1, "accepted", 2);
      expect(t.handoff(h(1)).delivery).toBe("acknowledged");
      t.apply({ type: "wake.suppressed", handoffId: h(1), commandId, now: NOW });
      expect(t.handoff(h(1)).delivery).toBe("acknowledged");
      // Nothing can request another wake for a reviewed handoff.
      const again = t.apply({
        type: "wake.request",
        handoffId: h(1),
        messageId: msg(99),
        now: NOW,
      });
      expect(again.changed).toBe(false);
      expect(t.handoff(h(1)).wake?.commandId).toBe(commandId);
    }
  });

  it("caps automatic wakes, then holds the pair with a visible reason", () => {
    const t = settled();
    for (let attempt = 0; attempt < HELIX_MAX_WAKE_ATTEMPTS; attempt += 1) {
      const commandId = wakeFor(t, 1);
      t.apply({ type: "wake.suppressed", handoffId: h(1), commandId, now: NOW });
      expect(t.handoff(h(1)).delivery).toBe("pending");
    }
    const capped = t.apply({ type: "wake.request", handoffId: h(1), messageId: msg(98), now: NOW });
    expect(capped.handoff?.delivery).toBe("pending");
    expect(t.handoff(h(1)).wakeAttempts).toBe(HELIX_MAX_WAKE_ATTEMPTS);
    expect(t.pair.hold?.kind).toBe("uncertain");
    expect(t.pair.hold?.reason).toContain("could not wake the Lead");
  });

  it("re-enable re-caps the Builder's mode", () => {
    const t = new Harness();
    t.apply({ type: "disable", expectedRevision: t.pair.revision, now: NOW });
    t.apply({
      type: "enable",
      expectedRevision: t.pair.revision,
      builderRuntimeMode: "approval-required",
      now: NOW,
    });
    expect(t.pair.config.builderRuntimeMode).toBe("approval-required");
  });

  it("a Builder is replaced only while the pair is off", () => {
    const t = new Harness();
    expect(
      t.refuse({ type: "builder.replaced", builderThreadId: ThreadId.makeUnsafe("b2"), now: NOW })
        .code,
    ).toBe("invalid_transition");
    t.apply({ type: "disable", expectedRevision: t.pair.revision, now: NOW });
    t.apply({ type: "builder.replaced", builderThreadId: ThreadId.makeUnsafe("b2"), now: NOW });
    expect(t.pair.builderThreadId).toBe("b2");
    expect(t.pair.builderCreatedAt).toBeNull();
  });
});

describe("nothing queues Builder work under a Stop", () => {
  it("refuses a changes_requested review while stopped; accept and block stay allowed", () => {
    for (const verdict of ["accepted", "blocked"] as const) {
      const t = new Harness();
      t.delegate(1);
      t.builderCreated();
      t.dispatch(1);
      t.settle(1);
      t.apply({ type: "stop", now: NOW });
      if (verdict === "blocked") {
        expect(t.refuse(reviewCommand(1, "changes_requested")).code).toBe("pair_held");
      }
      t.apply(reviewCommand(1, verdict));
      expect(t.handoff(h(1)).state).toBe(verdict);
      expect(t.aggregate.handoffs.some((handoff) => handoff.state === "prepared")).toBe(false);
      // Delegation is refused under the Stop as well.
      expect(t.refuse(delegateCommand(9)).code).toBe("pair_held");
    }
  });

  it("an explicit Resume tries one more wake past the cap", () => {
    const t = new Harness();
    t.delegate(1);
    t.builderCreated();
    t.dispatch(1);
    t.settle(1);
    for (let attempt = 0; attempt < HELIX_MAX_WAKE_ATTEMPTS; attempt += 1) {
      t.apply({ type: "wake.request", handoffId: h(1), messageId: msg(60 + attempt), now: NOW });
      const commandId = t.handoff(h(1)).wake!.commandId;
      t.apply({ type: "wake.suppressed", handoffId: h(1), commandId, now: NOW });
    }
    t.apply({ type: "wake.request", handoffId: h(1), messageId: msg(70), now: NOW });
    expect(t.pair.hold?.kind).toBe("uncertain");
    const resumed = t.apply({ type: "resume", expectedRevision: t.pair.revision, now: NOW });
    expect(resumed.effects).toContainEqual({
      type: "deliver_result",
      handoffId: h(1),
      wakeAllowed: true,
      afterResume: true,
    });
    t.apply({
      type: "wake.request",
      handoffId: h(1),
      messageId: msg(71),
      afterResume: true,
      now: NOW,
    });
    expect(t.handoff(h(1)).delivery).toBe("wake_requested");
    expect(t.handoff(h(1)).wakeAttempts).toBe(HELIX_MAX_WAKE_ATTEMPTS + 1);
    expect(t.pair.hold).toBeNull();
  });
});

describe("pending changes from a message", () => {
  const gpt55 = Schema.decodeSync(ModelSelection)({ provider: "codex", model: "gpt-5.5" });
  it("a Builder update clears only a pending Builder change, never a pending off", () => {
    const t = new Harness();
    t.apply({ type: "config.pending", change: { kind: "disable" }, now: NOW });
    t.apply({
      type: "config.update",
      expectedRevision: t.pair.revision,
      builderModelSelection: gpt55,
      now: NOW,
    });
    expect(t.pair.config.pendingChange).toEqual({ kind: "disable" });
    t.apply({
      type: "config.pending",
      change: { kind: "builder", builderModelSelection: codex },
      now: NOW,
    });
    t.apply({
      type: "config.update",
      expectedRevision: t.pair.revision,
      builderModelSelection: codex,
      now: NOW,
    });
    expect(t.pair.config.pendingChange ?? null).toBeNull();
  });
});
