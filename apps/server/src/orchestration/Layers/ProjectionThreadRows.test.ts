import { Effect, Exit, Schema, SchemaIssue } from "effect";
import { FastCheck } from "effect/testing";
import { describe, expect, it } from "vitest";

import {
  decodeProjectionThreadDbRows,
  decodeProjectionThreadShellDbRows,
  mapProjectionThreadDbRow,
  mapProjectionThreadShellDbRow,
  ProjectionThreadDbRowSchema,
  ProjectionThreadShellDbRowSchema,
} from "./ProjectionThreadRows.ts";

type DbRow = Record<string, unknown>;

// Raw `model_selection_json` values; the column is parsed here and decoded later.
const MODEL_SELECTION_JSON = [
  '{"provider":"codex","model":"gpt-5-codex"}',
  '{"provider":"claudeAgent","instanceId":"claude-work","model":"claude-opus","options":{"effort":"high"}}',
  '{"model":"legacy-without-provider"}',
  "[]",
  "null",
  '"just a string"',
];

// Columns whose schema is `Trim` + non-empty, so the mapper must trim them.
const ENTITY_ID_COLUMNS = [
  "threadId",
  "projectId",
  "parentThreadId",
  "sourceThreadId",
  "sourceTurnId",
  "forkSourceThreadId",
  "forkSourceMessageId",
  "sidechatSourceThreadId",
  "latestTurnId",
  "usageLimitRecoveryCancelledTurnId",
] as const;

const SHELL_JSON_COLUMNS = [
  "usageLimitRecovery",
  "usageLimitRecoverySource",
  "handoff",
  "claudeCacheReview",
  "lastKnownPr",
  "sidechatContext",
] as const;
const FULL_JSON_COLUMNS = [...SHELL_JSON_COLUMNS, "pinnedMessages", "goalAchievements"] as const;

// Stored as SQLite integers, read as numbers and turned into booleans by callers.
const INTEGER_FLAG_COLUMNS = ["isProjectImport", "createBranchFlowCompleted", "isPinned"] as const;

// `withDecodingDefault(() => null)` fields: the schema fills null when the value is undefined.
const DEFAULTED_COLUMNS = [
  "workingDirectory",
  "creationSource",
  "sourceThreadId",
  "sourceTurnId",
  "gatewayOperationId",
  "gatewayOperationIndex",
  "sidechatLastActivityAt",
  "sidechatExpiredAt",
  "goalStartedAt",
  "goalPausedAt",
  "archivedAt",
  "settledAt",
  "snoozedUntil",
  "snoozeReminderAt",
] as const;

interface RowCase<S extends Schema.Top & { readonly DecodingServices: never }> {
  readonly name: string;
  readonly schema: S & { readonly fields: Readonly<Record<string, unknown>> };
  readonly map: (row: DbRow) => unknown;
  readonly decodeRows: (rows: ReadonlyArray<unknown>) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly jsonColumns: ReadonlyArray<string>;
  readonly extraDefaulted: ReadonlyArray<string>;
}

const cases = [
  {
    name: "shell row",
    schema: ProjectionThreadShellDbRowSchema,
    map: mapProjectionThreadShellDbRow,
    decodeRows: decodeProjectionThreadShellDbRows,
    jsonColumns: SHELL_JSON_COLUMNS,
    extraDefaulted: [],
  },
  {
    name: "full row",
    schema: ProjectionThreadDbRowSchema,
    map: mapProjectionThreadDbRow,
    decodeRows: decodeProjectionThreadDbRows,
    jsonColumns: FULL_JSON_COLUMNS,
    extraDefaulted: ["goalAchievements"],
  },
] as const satisfies ReadonlyArray<RowCase<Schema.Top & { readonly DecodingServices: never }>>;

/**
 * Database-shaped rows generated from the schema itself: arbitrary decoded
 * values encoded back to columns (JSON strings, integers). A column added to the
 * schema shows up here, and in the schema decode, without touching this test.
 * Like a SELECT, every row carries every column, with NULL for absent values.
 */
function sampleRows(
  schema: Schema.Top & { readonly fields: Readonly<Record<string, unknown>> },
  count: number,
  seed: number,
): DbRow[] {
  const encode = Schema.encodeUnknownSync(schema as unknown as Schema.Codec<unknown, unknown>);
  const values = FastCheck.sample(Schema.toArbitrary(Schema.toType(schema)), {
    numRuns: count,
    seed,
  }) as DbRow[];
  return values.map((value, index) => {
    const encoded = encode({ ...value, modelSelection: {} }) as DbRow;
    const row: DbRow = {};
    for (const column of Object.keys(schema.fields)) {
      row[column] = encoded[column] ?? null;
    }
    row.modelSelection = MODEL_SELECTION_JSON[index % MODEL_SELECTION_JSON.length];
    return row;
  });
}

function decodeWithSchema(schema: Schema.Top, row: unknown) {
  return Schema.decodeUnknownExit(schema as Schema.Codec<unknown, unknown>)(row);
}

function expectMapperMatchesSchema(
  testCase: (typeof cases)[number],
  row: DbRow,
  label: string,
): void {
  const decoded = decodeWithSchema(testCase.schema, row);
  if (Exit.isFailure(decoded)) {
    throw new Error(`${label}: fixture is not a valid row: ${String(decoded.cause)}`);
  }
  const mapped = testCase.map(row);
  expect(mapped, `${label}: mapper fell back to the schema`).toBeDefined();
  expect(mapped, label).toStrictEqual(decoded.value);
}

function formatFailure(exit: Exit.Exit<unknown, unknown>): string {
  if (Exit.isSuccess(exit)) {
    return "success";
  }
  const error = exit.cause.reasons
    .map((reason) => ("error" in reason ? reason.error : undefined))
    .find((value) => value !== undefined);
  expect(Schema.isSchemaError(error)).toBe(true);
  return SchemaIssue.makeFormatterDefault()((error as Schema.SchemaError).issue);
}

for (const testCase of cases) {
  const columns = Object.keys(testCase.schema.fields);
  const samples = sampleRows(testCase.schema, 400, 20_261_111);
  const findSample = (column: string, predicate: (value: unknown) => boolean) => {
    const sample = samples.find((row) => predicate(row[column]));
    if (!sample) {
      throw new Error(`no generated ${testCase.name} has a suitable "${column}" value`);
    }
    return sample;
  };

  describe(`ProjectionThreadRows ${testCase.name} mapper`, () => {
    it("matches the schema decode on rows generated from the schema", () => {
      for (const [index, row] of samples.entries()) {
        expectMapperMatchesSchema(testCase, row, `sample ${index}`);
      }
    });

    it("covers every column in its null and non-null forms", () => {
      const base = findSample("threadId", (value) => typeof value === "string");
      for (const column of columns) {
        const nonNull = findSample(column, (value) => value !== null && value !== undefined);
        expectMapperMatchesSchema(
          testCase,
          { ...base, [column]: nonNull[column] },
          `${column} non-null`,
        );
        const withNull = { ...base, [column]: null };
        if (Exit.isSuccess(decodeWithSchema(testCase.schema, withNull))) {
          expectMapperMatchesSchema(testCase, withNull, `${column} null`);
        }
      }
    });

    it("trims entity ids like Schema.Trim", () => {
      const base = findSample("threadId", (value) => typeof value === "string");
      for (const column of ENTITY_ID_COLUMNS) {
        expectMapperMatchesSchema(
          testCase,
          { ...base, [column]: ` \t${column}-value \n` },
          `${column} padded`,
        );
      }
    });

    it("passes integer flags through as numbers", () => {
      const base = findSample("threadId", (value) => typeof value === "string");
      for (const column of INTEGER_FLAG_COLUMNS) {
        for (const value of [0, 1, 2]) {
          expectMapperMatchesSchema(testCase, { ...base, [column]: value }, `${column}=${value}`);
        }
      }
    });

    it("applies decoding defaults to undefined values", () => {
      const base = findSample("threadId", (value) => typeof value === "string");
      for (const column of [...DEFAULTED_COLUMNS, ...testCase.extraDefaulted]) {
        expect(columns).toContain(column);
        expectMapperMatchesSchema(
          testCase,
          { ...base, [column]: undefined },
          `${column} undefined`,
        );
      }
    });

    it("decodes every JSON column with its own schema", () => {
      for (const column of [...testCase.jsonColumns, "modelSelection"]) {
        expect(columns).toContain(column);
        const nonNull = findSample(column, (value) => typeof value === "string");
        expectMapperMatchesSchema(testCase, nonNull, `${column} JSON`);
      }
    });

    it("fails the whole read with the schema's error on a malformed row", () => {
      const rows = samples.slice(0, 5);
      const badValues = [
        ...[...testCase.jsonColumns, "modelSelection"].flatMap((column) => [
          [column, "{not json"],
          [column, 42],
        ]),
        ...[...testCase.jsonColumns].map((column) => [column, '{"unexpected":"shape"}']),
        ["threadId", "   "],
        ["projectId", null],
        ["latestTurnId", 7],
      ] as const;
      const schemaDecode = Schema.decodeUnknownExit(
        Schema.mutable(Schema.Array(testCase.schema as Schema.Codec<unknown, unknown>)),
      );
      for (const [column, value] of badValues) {
        const broken = [...rows];
        broken[3] = { ...rows[3]!, [column]: value };
        expect(testCase.map(broken[3]!), `${column}=${String(value)} maps`).toBeUndefined();
        const expected = schemaDecode(broken);
        expect(Exit.isFailure(expected), `${column}=${String(value)} schema fails`).toBe(true);
        const actual = Effect.runSyncExit(testCase.decodeRows(broken));
        expect(formatFailure(actual), `${column}=${String(value)}`).toBe(formatFailure(expected));
      }
    });

    it("defers to the schema when a column is missing from the rows", () => {
      const schemaDecode = Schema.decodeUnknownSync(
        Schema.mutable(Schema.Array(testCase.schema as Schema.Codec<unknown, unknown>)),
      );
      const rows = samples.slice(0, 3).map(({ workingDirectory: _omitted, ...row }) => row);
      expect(Effect.runSync(testCase.decodeRows(rows))).toStrictEqual(schemaDecode(rows));
    });

    it("decodes a bulk read to the same rows as the schema", () => {
      const schemaDecode = Schema.decodeUnknownSync(
        Schema.mutable(Schema.Array(testCase.schema as Schema.Codec<unknown, unknown>)),
      );
      expect(Effect.runSync(testCase.decodeRows(samples))).toStrictEqual(schemaDecode(samples));
      expect(Effect.runSync(testCase.decodeRows([]))).toStrictEqual([]);
    });
  });
}
