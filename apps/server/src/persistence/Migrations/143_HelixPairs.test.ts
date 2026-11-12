import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import migration from "./143_HelixPairs.ts";

it.effect("creates the Helix tables and replays without touching existing rows", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 143 });
    yield* sql`INSERT INTO helix_pairs (
      pair_id, project_id, lead_thread_id, builder_thread_id, lifecycle, revision,
      cancellation_epoch, goal_json, config_json, created_at, updated_at
    ) VALUES ('pair', 'project', 'lead', 'builder', 'active', 0, 0, '{}', '{}', 'now', 'now')`;
    yield* sql`INSERT INTO helix_handoffs (
      handoff_id, pair_id, sequence, request_id, request_fingerprint, work_item_id,
      correction_index, goal_seq, epoch, state, delivery, revision, record_json, created_at, updated_at
    ) VALUES ('h1', 'pair', 1, 'r1', 'fp', 'h1', 0, 0, 0, 'prepared', 'none', 0, '{}', 'now', 'now')`;

    // Replay is a no-op: the migration is idempotent.
    yield* migration;
    yield* migration;
    assert.lengthOf(yield* sql`SELECT pair_id FROM helix_pairs`, 1);
    assert.lengthOf(yield* sql`SELECT handoff_id FROM helix_handoffs`, 1);

    // The database itself enforces one active handoff per pair.
    const second = yield* Effect.exit(sql`INSERT INTO helix_handoffs (
      handoff_id, pair_id, sequence, request_id, request_fingerprint, work_item_id,
      correction_index, goal_seq, epoch, state, delivery, revision, record_json, created_at, updated_at
    ) VALUES ('h2', 'pair', 2, 'r2', 'fp', 'h2', 0, 0, 0, 'running', 'none', 0, '{}', 'now', 'now')`);
    assert.isTrue(second._tag === "Failure");

    // A thread cannot lead two pairs, and a pair cannot pair a thread with itself.
    const sameLead = yield* Effect.exit(sql`INSERT INTO helix_pairs (
      pair_id, project_id, lead_thread_id, builder_thread_id, lifecycle, revision,
      cancellation_epoch, goal_json, config_json, created_at, updated_at
    ) VALUES ('pair-2', 'project', 'lead', 'builder-2', 'active', 0, 0, '{}', '{}', 'now', 'now')`);
    assert.isTrue(sameLead._tag === "Failure");
    const selfPair = yield* Effect.exit(sql`INSERT INTO helix_pairs (
      pair_id, project_id, lead_thread_id, builder_thread_id, lifecycle, revision,
      cancellation_epoch, goal_json, config_json, created_at, updated_at
    ) VALUES ('pair-3', 'project', 'solo', 'solo', 'active', 0, 0, '{}', '{}', 'now', 'now')`);
    assert.isTrue(selfPair._tag === "Failure");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
