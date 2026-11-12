import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HelixHandoffId,
  HelixPairId,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { createHelixPair, transitionHelix } from "../helix/stateMachine";
import { makeHelixRepository } from "./Layers/HelixRepository";
import {
  inspectMigrationBackupPlan,
  restoreMarkedMigrationBackup,
  runWithPreMigrationBackup,
} from "./MigrationBackup";
import { migrationEntries, planMigrationLineageAliasRepairs, runMigrations } from "./Migrations";
import usageMigration from "./Migrations/147_UsageAnalyticsDeletedTokens";
import * as NodeSqliteClient from "./NodeSqliteClient";

const NOW = "2026-11-13T01:00:00.000Z";
const USAGE_IDENTITY = [147, "UsageAnalyticsDeletedTokens"] as const;

const tracker = (sql: SqlClient.SqlClient) =>
  sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

const helixSnapshot = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const schema = yield* sql<{
      readonly name: string;
      readonly type: string;
      readonly sql: string | null;
    }>`
    SELECT name, type, sql FROM sqlite_master
    WHERE tbl_name LIKE 'helix_%' ORDER BY type, name
  `;
    const tables = schema.filter((row) => row.type === "table");
    const data = yield* Effect.forEach(
      tables,
      (table) => sql`SELECT * FROM ${sql(table.name)} ORDER BY rowid`,
    );
    return { schema, data };
  });

const seedHelix = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* makeHelixRepository;
  const builder = Schema.decodeSync(ModelSelection)({ provider: "codex", model: "gpt-5" });
  for (const name of ["active", "stopped"]) {
    const created = createHelixPair({
      pairId: Schema.decodeSync(HelixPairId)(`helix-pair:migration-${name}`),
      projectId: ProjectId.makeUnsafe("migration-project"),
      leadThreadId: ThreadId.makeUnsafe(`migration-lead-${name}`),
      leadProvider: "claudeAgent",
      builderThreadId: ThreadId.makeUnsafe(`migration-builder-${name}`),
      builderModelSelection: builder,
      builderRuntimeMode: "approval-required",
      now: NOW,
    });
    if (!created.ok) return yield* Effect.die(new Error(created.error.message));
    yield* repository.createPair(created.pair);
    const next = transitionHelix(
      { pair: created.pair, handoffs: [] },
      name === "active"
        ? {
            type: "delegate",
            handoffId: Schema.decodeSync(HelixHandoffId)("helix-handoff:migration-active:1"),
            requestId: "migration-request",
            fingerprint: "original-request-fingerprint",
            brief: {
              title: "Keep this work",
              objective: "Preserve state",
              acceptanceCriteria: "No replay",
            },
            now: NOW,
          }
        : { type: "stop", now: NOW },
    );
    if (!next.ok) return yield* Effect.die(new Error(next.error.message));
    if (next.changed)
      yield* repository.commit({
        pair: next.pair,
        expectedRevision: next.expectedRevision,
        handoffs: next.writes,
      });
  }
  yield* sql`INSERT INTO helix_retired_threads VALUES ('retired-builder', 'old-pair', ${NOW})`;
  yield* sql`INSERT INTO helix_stop_requests VALUES ('helix-pair:migration-active', ${NOW})`;
  yield* sql`INSERT INTO helix_applied_messages VALUES ('accepted-message', 'pairing', ${NOW}), ('accepted-message', 'goal', ${NOW})`;
  return {
    pairs: yield* repository.listPairs(),
    handoffs: yield* repository.listHandoffs(
      Schema.decodeSync(HelixPairId)("helix-pair:migration-active"),
    ),
  };
});

it.effect("appends 147 without changing any existing Helix row, schema or migration receipt", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 146 });
    const beforeRead = yield* seedHelix;
    const before = yield* helixSnapshot(sql);
    const oldTracker = yield* tracker(sql);
    assert.deepStrictEqual(yield* inspectMigrationBackupPlan, {
      sourceVersion: "v146",
      targetVersion: 147,
    });
    assert.deepStrictEqual(yield* runMigrations(), [USAGE_IDENTITY]);
    assert.deepStrictEqual(yield* helixSnapshot(sql), before);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 146 ORDER BY migration_id`,
      oldTracker,
    );
    const repository = yield* makeHelixRepository;
    assert.deepStrictEqual(yield* repository.listPairs(), beforeRead.pairs);
    assert.deepStrictEqual(
      yield* repository.listHandoffs(Schema.decodeSync(HelixPairId)("helix-pair:migration-active")),
      beforeRead.handoffs,
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* helixSnapshot(sql), before);
    assert.deepStrictEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect.each([143, 144, 145] as const)(
  "keeps applied Helix migration receipts when upgrading from %s",
  (version) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: version });
      const before = yield* tracker(sql);
      const executed = yield* runMigrations();
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        Array.from({ length: 147 - version }, (_, index) => version + index + 1),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= ${version} ORDER BY migration_id`,
        before,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("imports upstream's released 143 without replaying its prefix or losing usage data", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 142 });
    const prefix = yield* tracker(sql);
    yield* usageMigration;
    yield* sql`INSERT INTO usage_analytics_deleted_tokens VALUES ('upstream-thread', 'upstream-project', ${NOW}, 'agent', 'codex', 'model', 789)`;
    const usage = yield* sql`SELECT * FROM usage_analytics_deleted_tokens`;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (143, 'UsageAnalyticsDeletedTokens')`;
    assert.deepStrictEqual(yield* inspectMigrationBackupPlan, {
      sourceVersion: "v143",
      targetVersion: 147,
    });
    assert.deepStrictEqual(
      yield* runMigrations(),
      migrationEntries.filter(([id]) => id >= 143).map(([id, name]) => [id, name]),
    );
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 142 ORDER BY migration_id`,
      prefix,
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM usage_analytics_deleted_tokens`, usage);
    assert.lengthOf(
      (yield* helixSnapshot(sql)).schema.filter((row) => row.type === "table"),
      5,
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* sql`SELECT * FROM usage_analytics_deleted_tokens`, usage);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("only repairs the exact released upstream identity with a canonical prefix", () =>
  Effect.sync(() => {
    const names = new Map<number, string>(
      migrationEntries.filter(([id]) => id <= 142).map(([id, name]) => [id, name]),
    );
    names.set(143, "UsageAnalyticsDeletedTokens");
    assert.deepStrictEqual(planMigrationLineageAliasRepairs(names), [
      { kind: "remove", migrationId: 143 },
    ]);
    names.set(142, "UnrecognizedMigration");
    assert.deepStrictEqual(planMigrationLineageAliasRepairs(names), []);
  }),
);

it.effect.each(["Helix 146", "upstream 143"] as const)(
  "backs up and restores a populated %s database without losing state",
  (lineage) =>
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "arbor-helix-migration-"))),
      (directory) =>
        Effect.gen(function* () {
          const path = join(directory, "state.sqlite");
          const expected =
            lineage === "Helix 146"
              ? [USAGE_IDENTITY]
              : migrationEntries
                  .filter(([id]) => id >= 143)
                  .map(([id, name]) => [id, name] as const);
          const original = yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* runMigrations({ toMigrationInclusive: lineage === "Helix 146" ? 146 : 142 });
            if (lineage === "Helix 146") {
              yield* seedHelix;
            } else {
              yield* usageMigration;
              yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (143, 'UsageAnalyticsDeletedTokens')`;
              yield* sql`INSERT INTO usage_analytics_deleted_tokens VALUES ('saved-upstream-thread', NULL, ${NOW}, 'automation', 'codex', 'model', 123)`;
            }
            const usage = yield* lineage === "upstream 143"
              ? sql`SELECT * FROM usage_analytics_deleted_tokens`
              : Effect.succeed(null);
            const snapshot = {
              helix: yield* helixSnapshot(sql),
              tracker: yield* tracker(sql),
              usage,
            };
            assert.deepStrictEqual(
              yield* runWithPreMigrationBackup(path, runMigrations()),
              expected,
            );
            if (lineage === "Helix 146")
              assert.deepStrictEqual(yield* helixSnapshot(sql), snapshot.helix);
            if (usage !== null)
              assert.deepStrictEqual(
                yield* sql`SELECT * FROM usage_analytics_deleted_tokens`,
                usage,
              );
            return snapshot;
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: path })));
          yield* restoreMarkedMigrationBackup(path);
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(yield* helixSnapshot(sql), original.helix);
            assert.deepStrictEqual(yield* tracker(sql), original.tracker);
            if (original.usage !== null)
              assert.deepStrictEqual(
                yield* sql`SELECT * FROM usage_analytics_deleted_tokens`,
                original.usage,
              );
            assert.deepStrictEqual(yield* runMigrations(), expected);
            if (lineage === "Helix 146")
              assert.deepStrictEqual(yield* helixSnapshot(sql), original.helix);
            if (original.usage !== null)
              assert.deepStrictEqual(
                yield* sql`SELECT * FROM usage_analytics_deleted_tokens`,
                original.usage,
              );
          }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: path })));
        }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    ),
);
