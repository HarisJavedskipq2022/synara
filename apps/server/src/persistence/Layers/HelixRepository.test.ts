import {
  MessageId,
  ModelSelection,
  ProjectId,
  ThreadId,
  TurnId,
  type HelixHandoff,
  type HelixHandoffId,
  type HelixPair,
  type HelixPairId,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Exit, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { HelixRepository, type HelixRepositoryShape } from "../Services/HelixRepository";
import { HelixRepositoryLive } from "./HelixRepository";
import { SqlitePersistenceMemory } from "./Sqlite";
import { createHelixPair, transitionHelix, type HelixCommand } from "../../helix/stateMachine";
import { helixDispatchCommandId, helixWakeCommandId } from "../../helix/identity";

const layer = it.layer(HelixRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const NOW = "2026-11-12T10:00:00.000Z";
const codex = Schema.decodeSync(ModelSelection)({ provider: "codex", model: "gpt-5" });
const h = (pair: string, n: number) => `helix-handoff:${pair}:${n}` as HelixHandoffId;

function pairFor(name: string): HelixPair {
  const created = createHelixPair({
    pairId: `helix-pair:${name}` as HelixPairId,
    projectId: ProjectId.makeUnsafe("project"),
    leadThreadId: ThreadId.makeUnsafe(`lead:${name}`),
    leadProvider: "claudeAgent",
    builderThreadId: ThreadId.makeUnsafe(`builder:${name}`),
    builderModelSelection: codex,
    builderRuntimeMode: "approval-required",
    now: NOW,
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.pair;
}

/** Load the aggregate, apply a command, commit it: the coordinator's loop. */
const step = (repository: HelixRepositoryShape, pairId: HelixPairId, command: HelixCommand) =>
  Effect.gen(function* () {
    const pair = yield* repository.getPair(pairId);
    if (pair === null) return yield* Effect.die("missing pair");
    const handoffs = yield* repository.listHandoffs(pairId);
    const transition = transitionHelix({ pair, handoffs }, command);
    if (!transition.ok) return yield* Effect.die(transition.error.message);
    if (!transition.changed) return { pair, handoffs: [] as HelixHandoff[] };
    return yield* repository.commit({
      pair: transition.pair,
      expectedRevision: transition.expectedRevision,
      handoffs: transition.writes,
    });
  });

const delegate = (name: string, n: number, fingerprint = `fp-${n}`): HelixCommand => ({
  type: "delegate",
  handoffId: h(name, n),
  requestId: `request-${n}`,
  fingerprint,
  brief: { title: `Task ${n}`, objective: "Do it.", acceptanceCriteria: "Done." },
  now: NOW,
});

layer("HelixRepository", (it) => {
  it.effect("creates, reads and lists pairs with epoch and hold fields intact", () =>
    Effect.gen(function* () {
      const repository = yield* HelixRepository;
      const pair = pairFor("create");
      const stored = yield* repository.createPair(pair);
      assert.deepStrictEqual(stored, pair);
      assert.deepStrictEqual(yield* repository.getPair(pair.id), pair);
      assert.deepStrictEqual(yield* repository.getPairByLeadThread(pair.leadThreadId), pair);
      assert.deepStrictEqual(yield* repository.getParticipant(pair.leadThreadId), {
        pair,
        role: "lead",
      });
      assert.deepStrictEqual(yield* repository.getParticipant(pair.builderThreadId), {
        pair,
        role: "builder",
      });
      assert.isNull(yield* repository.getParticipant(ThreadId.makeUnsafe("someone-else")));
      assert.isTrue((yield* repository.listPairs()).some((row) => row.id === pair.id));

      const stopped = yield* step(repository, pair.id, { type: "stop", now: NOW });
      assert.equal(stopped.pair.revision, 1);
      assert.equal(stopped.pair.cancellationEpoch, 1);
      assert.deepStrictEqual(stopped.pair.hold, {
        kind: "stop",
        reason: "Stopped by the user.",
        limit: null,
        handoffId: null,
        epoch: 1,
        since: NOW,
      });
      assert.deepStrictEqual(yield* repository.getPair(pair.id), stopped.pair);
    }),
  );

  it.effect("refuses a thread that already participates in a pair, in either role", () =>
    Effect.gen(function* () {
      const repository = yield* HelixRepository;
      const pair = pairFor("participants");
      yield* repository.createPair(pair);
      const asLeadAgain = yield* Effect.exit(
        repository.createPair({
          ...pairFor("participants-2"),
          leadThreadId: pair.builderThreadId,
        }),
      );
      assert.isTrue(Exit.isFailure(asLeadAgain));
      const asBuilderAgain = yield* Effect.flip(
        repository.createPair({
          ...pairFor("participants-3"),
          builderThreadId: pair.leadThreadId,
        }),
      );
      assert.equal(asBuilderAgain.code, "participant_conflict");
    }),
  );

  it.effect("guards every commit with the pair revision", () =>
    Effect.gen(function* () {
      const repository = yield* HelixRepository;
      const pair = pairFor("revision");
      yield* repository.createPair(pair);
      const transition = transitionHelix({ pair, handoffs: [] }, delegate("revision", 1));
      assert.isTrue(transition.ok);
      if (!transition.ok) return;
      yield* repository.commit({
        pair: transition.pair,
        expectedRevision: transition.expectedRevision,
        handoffs: transition.writes,
      });
      // The same commit again: the pair moved on.
      const stale = yield* Effect.flip(
        repository.commit({
          pair: transition.pair,
          expectedRevision: transition.expectedRevision,
          handoffs: [],
        }),
      );
      assert.equal(stale.code, "stale_revision");
      // A revision that skips ahead is refused before touching storage.
      const skipping = yield* Effect.flip(
        repository.commit({
          pair: { ...transition.pair, revision: 5 },
          expectedRevision: 1,
          handoffs: [],
        }),
      );
      assert.equal(skipping.code, "stale_revision");
      const missing = yield* Effect.flip(
        repository.commit({
          pair: { ...transition.pair, id: "helix-pair:nope" as HelixPairId, revision: 2 },
          expectedRevision: 1,
          handoffs: [],
        }),
      );
      assert.equal(missing.code, "not_found");
      // Nothing above changed the stored rows.
      assert.equal((yield* repository.getPair(pair.id))?.revision, 1);
      assert.lengthOf(yield* repository.listHandoffs(pair.id), 1);
    }),
  );

  it.effect("guards handoff updates with their own revision and rolls back the whole commit", () =>
    Effect.gen(function* () {
      const repository = yield* HelixRepository;
      const pair = pairFor("handoff-revision");
      yield* repository.createPair(pair);
      const first = yield* step(repository, pair.id, delegate("handoff-revision", 1));
      const handoff = first.handoffs[0]!;
      const current = (yield* repository.getPair(pair.id))!;
      const bad = yield* Effect.flip(
        repository.commit({
          pair: { ...current, revision: current.revision + 1, hold: null },
          expectedRevision: current.revision,
          handoffs: [
            {
              kind: "update",
              handoff: { ...handoff, state: "cancelled", revision: 5 },
              expectedRevision: 4,
            },
          ],
        }),
      );
      assert.equal(bad.code, "stale_handoff_revision");
      assert.equal((yield* repository.getPair(pair.id))?.revision, current.revision);
      assert.equal((yield* repository.getHandoff(handoff.id))?.state, "prepared");
    }),
  );

  it.effect("makes request ids idempotent and refuses reuse with different content", () =>
    Effect.gen(function* () {
      const repository = yield* HelixRepository;
      const pair = pairFor("requests");
      yield* repository.createPair(pair);
      const first = yield* step(repository, pair.id, delegate("requests", 1));
      const stored = first.handoffs[0]!;
      assert.equal(stored.requestId, "request-1");
      assert.deepStrictEqual(
        yield* repository.findHandoffByRequestId(pair.id, "request-1"),
        stored,
      );

      // A racing writer that skipped the state machine's replay check still cannot fork.
      const current = (yield* repository.getPair(pair.id))!;
      const duplicate = yield* Effect.flip(
        repository.commit({
          pair: { ...current, revision: current.revision + 1 },
          expectedRevision: current.revision,
          handoffs: [
            {
              kind: "insert",
              handoff: { ...stored, id: h("requests", 2), sequence: 2, revision: 0 },
            },
          ],
        }),
      );
      assert.equal(duplicate.code, "duplicate_request");
      assert.equal(duplicate.existingHandoffId, stored.id);
      const conflict = yield* Effect.flip(
        repository.commit({
          pair: { ...current, revision: current.revision + 1 },
          expectedRevision: current.revision,
          handoffs: [
            {
              kind: "insert",
              handoff: {
                ...stored,
                id: h("requests", 2),
                sequence: 2,
                revision: 0,
                requestFingerprint: "other",
              },
            },
          ],
        }),
      );
      assert.equal(conflict.code, "request_conflict");
      assert.lengthOf(yield* repository.listHandoffs(pair.id), 1);
    }),
  );

  it.effect("allows at most one prepared, dispatching or running handoff per pair", () =>
    Effect.gen(function* () {
      const repository = yield* HelixRepository;
      const pair = pairFor("one-active");
      yield* repository.createPair(pair);
      const first = yield* step(repository, pair.id, delegate("one-active", 1));
      const current = (yield* repository.getPair(pair.id))!;
      const second = yield* Effect.flip(
        repository.commit({
          pair: { ...current, revision: current.revision + 1 },
          expectedRevision: current.revision,
          handoffs: [
            {
              kind: "insert",
              handoff: {
                ...first.handoffs[0]!,
                id: h("one-active", 2),
                requestId: "request-2",
                requestFingerprint: "fp-2",
                sequence: 2,
              },
            },
          ],
        }),
      );
      assert.equal(second.code, "active_handoff_exists");
      assert.equal(second.existingHandoffId, h("one-active", 1));

      // Another pair is unaffected.
      const other = pairFor("one-active-other");
      yield* repository.createPair(other);
      yield* step(repository, other.id, delegate("one-active-other", 1));
      assert.lengthOf(yield* repository.listHandoffs(other.id), 1);
    }),
  );

  it.effect("resolves dispatch and wake command ids back to their handoff", () =>
    Effect.gen(function* () {
      const repository = yield* HelixRepository;
      const pair = pairFor("commands");
      yield* repository.createPair(pair);
      const id = h("commands", 1);
      yield* step(repository, pair.id, delegate("commands", 1));
      yield* step(repository, pair.id, { type: "builder.created", now: NOW });
      yield* step(repository, pair.id, {
        type: "dispatch.start",
        handoffId: id,
        messageId: MessageId.makeUnsafe("brief-1"),
        now: NOW,
      });
      const dispatchCommand = helixDispatchCommandId(id, 1);
      const dispatched = yield* repository.findAutomaticTurn(dispatchCommand);
      assert.equal(dispatched?.kind, "dispatch");
      assert.equal(dispatched?.handoff.id, id);
      assert.equal(dispatched?.pair.id, pair.id);
      assert.isNull(yield* repository.findAutomaticTurn("helix:dispatch:unknown:1"));

      yield* step(repository, pair.id, {
        type: "dispatch.acknowledged",
        handoffId: id,
        commandId: dispatchCommand,
        builderTurnId: TurnId.makeUnsafe("turn-1"),
        now: NOW,
      });
      yield* step(repository, pair.id, {
        type: "turn.settled",
        handoffId: id,
        builderTurnId: TurnId.makeUnsafe("turn-1"),
        turnOutcome: "completed",
        finalMessage: "ok",
        now: NOW,
      });
      yield* step(repository, pair.id, {
        type: "wake.request",
        handoffId: id,
        messageId: MessageId.makeUnsafe("wake-1"),
        now: NOW,
      });
      const woken = yield* repository.findAutomaticTurn(helixWakeCommandId(id, 1));
      assert.equal(woken?.kind, "wake");
      assert.equal(woken?.handoff.delivery, "wake_requested");
    }),
  );

  it.effect("lists unresolved handoffs for restart reconciliation", () =>
    Effect.gen(function* () {
      const repository = yield* HelixRepository;
      const pair = pairFor("unresolved");
      yield* repository.createPair(pair);
      yield* step(repository, pair.id, delegate("unresolved", 1));
      const unresolved = yield* repository.listUnresolvedHandoffs();
      assert.isTrue(unresolved.some((handoff) => handoff.id === h("unresolved", 1)));
      yield* step(repository, pair.id, { type: "stop", now: NOW });
      const afterStop = yield* repository.listUnresolvedHandoffs();
      assert.isFalse(afterStop.some((handoff) => handoff.id === h("unresolved", 1)));
    }),
  );

  it.effect("deletes a pair with its handoffs", () =>
    Effect.gen(function* () {
      const repository = yield* HelixRepository;
      const pair = pairFor("delete");
      yield* repository.createPair(pair);
      yield* step(repository, pair.id, delegate("delete", 1));
      yield* repository.deletePair(pair.id);
      assert.isNull(yield* repository.getPair(pair.id));
      assert.isNull(yield* repository.getHandoff(h("delete", 1)));
      assert.isNull(yield* repository.getParticipant(pair.builderThreadId));
    }),
  );

  it.effect("tolerant listings skip an unreadable handoff row and name it", () =>
    Effect.gen(function* () {
      const repository = yield* HelixRepository;
      const sql = yield* SqlClient.SqlClient;
      const pair = yield* repository.createPair(pairFor("tolerant"));
      yield* step(repository, pair.id, delegate("tolerant", 1));
      yield* sql`UPDATE helix_handoffs SET record_json = '{"broken":' WHERE handoff_id = ${h("tolerant", 1)}`;
      const listed = yield* repository.listHandoffsTolerant(pair.id);
      assert.deepStrictEqual(listed.invalid, [h("tolerant", 1)]);
      assert.lengthOf(listed.handoffs, 0);
      const unresolved = yield* repository.listUnresolvedHandoffsTolerant();
      assert.include(unresolved.invalidPairIds, pair.id);
      // The strict listing still refuses, so callers must opt in to tolerance.
      assert.isTrue(Exit.isFailure(yield* Effect.exit(repository.listHandoffs(pair.id))));
    }),
  );

  it.effect("a disabled pair can take a fresh Builder thread id", () =>
    Effect.gen(function* () {
      const repository = yield* HelixRepository;
      const pair = yield* repository.createPair(pairFor("replace"));
      yield* step(repository, pair.id, {
        type: "disable",
        expectedRevision: pair.revision,
        now: NOW,
      });
      const disabled = (yield* repository.getPair(pair.id))!;
      yield* step(repository, pair.id, {
        type: "builder.replaced",
        builderThreadId: ThreadId.makeUnsafe("builder:replace-2"),
        now: NOW,
      });
      const replaced = (yield* repository.getPair(pair.id))!;
      assert.equal(replaced.builderThreadId, "builder:replace-2");
      assert.equal(replaced.revision, disabled.revision + 1);
      assert.equal(
        (yield* repository.getParticipant(ThreadId.makeUnsafe("builder:replace-2")))?.role,
        "builder",
      );
      assert.isNull(yield* repository.getParticipant(pair.builderThreadId));
    }),
  );
});
