import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeHelixCoordinator } from "../../helix/coordinator.ts";
import { HelixRepositoryLive } from "../Layers/HelixRepository.ts";
import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import { HelixRepository } from "../Services/HelixRepository.ts";
import migration144 from "./144_HelixRetiredBuilders.ts";
import migration145 from "./145_HelixStopRequests.ts";

/**
 * A database that applied the Helix migrations as they first shipped in this
 * branch (143, then 144 with only `helix_retired_threads`) must migrate
 * forward and boot the current Helix code: every Helix table it reads comes
 * from its own append-only migration.
 */
it.effect("a database stopped at 143, or at the first 144, migrates forward and boots Helix", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 143 });
    yield* sql`INSERT INTO helix_pairs (
      pair_id, project_id, lead_thread_id, builder_thread_id, lifecycle, revision,
      cancellation_epoch, goal_json, config_json, created_at, updated_at
    ) VALUES ('pair', 'project', 'lead', 'builder', 'active', 0, 0, '{}', '{}', 'now', 'now')`;
    yield* runMigrations({ toMigrationInclusive: 144 });
    const tablesAt144 = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'helix_%' ORDER BY name
    `;
    assert.deepStrictEqual(
      tablesAt144.map((row) => row.name),
      ["helix_handoffs", "helix_pairs", "helix_retired_threads"],
    );

    // The current server: migrates forward, then Helix boots and reads every table.
    yield* runMigrations();
    yield* migration144;
    yield* migration145;
    const repository = yield* HelixRepository;
    yield* repository.recordStopRequest("pair");
    assert.deepStrictEqual(yield* repository.listStopRequests(), ["pair"]);
    assert.deepStrictEqual(yield* repository.listRetiredThreads(), []);
    const coordinator = yield* makeHelixCoordinator({
      repository,
      runtime: {} as never,
      isEnabled: Effect.succeed(false),
      setRoleProfile: () => {},
    });
    // The pair row above does not decode: quarantined, never a failed boot.
    assert.isTrue(coordinator.hooks.roleOf("lead")?.quarantined);
  }).pipe(
    Effect.provide(HelixRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()))),
  ),
);
