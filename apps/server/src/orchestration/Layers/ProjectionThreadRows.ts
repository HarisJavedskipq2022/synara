/**
 * Row shapes and bulk decoders for `projection_threads` reads.
 *
 * The schemas below are the single definition of a thread row. Single-row and
 * small-set readers decode through them directly. The bulk readers (the
 * connect shell snapshot and the engine's command read model read every row in
 * the table) go through a trusted hand-written mapper instead: per-row schema
 * decoding of ~60 mostly-null columns was most of the cost of those reads.
 *
 * The mapper only runs on rows this server wrote, so it does not re-validate
 * scalar columns. It does reproduce every transformation the schema applies
 * (id trimming, decoding defaults, JSON columns), and it falls back to the
 * schema decode whenever it meets anything it cannot map exactly: a missing
 * column, a non-string or blank id, or a JSON column that does not decode. The
 * fallback returns the schema's own result, so a malformed row fails the whole
 * read with the same `SchemaError` as before. `ProjectionThreadRows.test.ts`
 * checks the mapper against the schema decode.
 */
import {
  OrchestrationThreadPullRequest,
  PendingClaudeCacheReview,
  ThreadGoalAchievements,
  ThreadHandoff,
  ThreadPinnedMessages,
  ThreadSidechatContext,
  UsageLimitRecovery,
  UsageLimitRecoverySource,
} from "@synara/contracts";
import { Effect, Exit, Schema, Struct } from "effect";

import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";

const ModelSelectionJsonUnknown = Schema.fromJsonString(Schema.Unknown);

export const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    isProjectImport: Schema.Number,
    createBranchFlowCompleted: Schema.Number,
    isPinned: Schema.Number,
    usageLimitRecovery: Schema.optional(Schema.NullOr(Schema.fromJsonString(UsageLimitRecovery))),
    usageLimitRecoverySource: Schema.optional(
      Schema.NullOr(Schema.fromJsonString(UsageLimitRecoverySource)),
    ),
    handoff: Schema.NullOr(Schema.fromJsonString(ThreadHandoff)),
    claudeCacheReview: Schema.optional(
      Schema.NullOr(Schema.fromJsonString(PendingClaudeCacheReview)),
    ),
    lastKnownPr: Schema.NullOr(Schema.fromJsonString(OrchestrationThreadPullRequest)),
    sidechatContext: Schema.optional(Schema.NullOr(Schema.fromJsonString(ThreadSidechatContext))),
    pinnedMessages: Schema.NullOr(Schema.fromJsonString(ThreadPinnedMessages)),
    goalAchievements: Schema.optional(
      Schema.NullOr(Schema.fromJsonString(ThreadGoalAchievements)),
    ).pipe(Schema.withDecodingDefault(() => null)),
    modelSelection: ModelSelectionJsonUnknown,
  }),
);
const {
  pinnedMessages: _projectionThreadPinnedMessagesField,
  notes: _projectionThreadNotesField,
  goalAchievements: _projectionThreadGoalAchievementsField,
  ...ProjectionThreadShellFields
} = ProjectionThread.fields;
export const ProjectionThreadShellDbRowSchema = Schema.Struct(
  ProjectionThreadShellFields,
).mapFields(
  Struct.assign({
    isProjectImport: Schema.Number,
    createBranchFlowCompleted: Schema.Number,
    isPinned: Schema.Number,
    usageLimitRecovery: Schema.optional(Schema.NullOr(Schema.fromJsonString(UsageLimitRecovery))),
    usageLimitRecoverySource: Schema.optional(
      Schema.NullOr(Schema.fromJsonString(UsageLimitRecoverySource)),
    ),
    handoff: Schema.NullOr(Schema.fromJsonString(ThreadHandoff)),
    claudeCacheReview: Schema.optional(
      Schema.NullOr(Schema.fromJsonString(PendingClaudeCacheReview)),
    ),
    lastKnownPr: Schema.NullOr(Schema.fromJsonString(OrchestrationThreadPullRequest)),
    sidechatContext: Schema.optional(Schema.NullOr(Schema.fromJsonString(ThreadSidechatContext))),
    modelSelection: ModelSelectionJsonUnknown,
  }),
);

export type ProjectionThreadDbRowRaw = Schema.Schema.Type<typeof ProjectionThreadDbRowSchema>;
export type ProjectionThreadShellDbRowRaw = Schema.Schema.Type<
  typeof ProjectionThreadShellDbRowSchema
>;

// The modelSelection column stays parsed-but-undecoded JSON here; callers
// normalize and decode it against current settings afterwards.
type ModelSelectionJson = Schema.Schema.Type<typeof ModelSelectionJsonUnknown>;

/** Thrown inside the mapper when a row needs the schema decode; never escapes this module. */
const NEEDS_SCHEMA_DECODE = new Error("projection thread row needs the schema decode");

type DbRow = Readonly<Record<string, unknown>>;

const decodeJsonColumnExit = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
) => {
  const decode = Schema.decodeUnknownExit(Schema.fromJsonString(schema));
  return (value: unknown): S["Type"] | null => {
    if (value === null) {
      return null;
    }
    const exit = decode(value);
    if (Exit.isFailure(exit)) {
      throw NEEDS_SCHEMA_DECODE;
    }
    return exit.value;
  };
};

const decodeUsageLimitRecovery = decodeJsonColumnExit(UsageLimitRecovery);
const decodeUsageLimitRecoverySource = decodeJsonColumnExit(UsageLimitRecoverySource);
const decodeHandoff = decodeJsonColumnExit(ThreadHandoff);
const decodeClaudeCacheReview = decodeJsonColumnExit(PendingClaudeCacheReview);
const decodeLastKnownPr = decodeJsonColumnExit(OrchestrationThreadPullRequest);
const decodeSidechatContext = decodeJsonColumnExit(ThreadSidechatContext);
const decodePinnedMessages = decodeJsonColumnExit(ThreadPinnedMessages);
const decodeGoalAchievements = decodeJsonColumnExit(ThreadGoalAchievements);

const optionalJsonColumn = <A>(
  value: unknown,
  decode: (value: unknown) => A | null,
): A | null | undefined => (value === undefined ? undefined : decode(value));

function parseModelSelectionJson(value: unknown): ModelSelectionJson {
  if (typeof value !== "string") {
    throw NEEDS_SCHEMA_DECODE;
  }
  try {
    return JSON.parse(value);
  } catch {
    throw NEEDS_SCHEMA_DECODE;
  }
}

// Entity ids decode through `Schema.Trim` plus a non-empty check.
function entityId<A>(value: unknown): A {
  if (typeof value !== "string") {
    throw NEEDS_SCHEMA_DECODE;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw NEEDS_SCHEMA_DECODE;
  }
  return trimmed as A;
}

function nullableEntityId<A>(value: unknown): A | null {
  return value === null ? null : entityId<A>(value);
}

function optionalNullableEntityId<A>(value: unknown): A | null | undefined {
  return value === undefined ? undefined : nullableEntityId<A>(value);
}

function defaultedNullableEntityId<A>(value: unknown): A | null {
  return value === undefined ? null : nullableEntityId<A>(value);
}

type Shell = ProjectionThreadShellDbRowRaw;

// Mirrors the schema field by field. Fields declared with
// `withDecodingDefault(() => null)` read `?? null`; plain `Schema.optional`
// fields keep `undefined` as the schema does.
function mapShellColumns(row: DbRow): Shell {
  const r = row as { readonly [K in keyof Shell]: unknown };
  return {
    threadId: entityId<Shell["threadId"]>(r.threadId),
    projectId: entityId<Shell["projectId"]>(r.projectId),
    title: r.title as Shell["title"],
    modelSelection: parseModelSelectionJson(r.modelSelection),
    runtimeMode: r.runtimeMode as Shell["runtimeMode"],
    interactionMode: r.interactionMode as Shell["interactionMode"],
    envMode: r.envMode as Shell["envMode"],
    branch: r.branch as Shell["branch"],
    worktreePath: r.worktreePath as Shell["worktreePath"],
    workingDirectory: (r.workingDirectory ?? null) as Shell["workingDirectory"],
    associatedWorktreePath: r.associatedWorktreePath as Shell["associatedWorktreePath"],
    associatedWorktreeBranch: r.associatedWorktreeBranch as Shell["associatedWorktreeBranch"],
    associatedWorktreeRef: r.associatedWorktreeRef as Shell["associatedWorktreeRef"],
    createBranchFlowCompleted: r.createBranchFlowCompleted as Shell["createBranchFlowCompleted"],
    isPinned: r.isPinned as Shell["isPinned"],
    parentThreadId: optionalNullableEntityId<Shell["parentThreadId"]>(r.parentThreadId),
    creationSource: (r.creationSource ?? null) as Shell["creationSource"],
    sourceThreadId: defaultedNullableEntityId<Shell["sourceThreadId"]>(r.sourceThreadId),
    sourceTurnId: defaultedNullableEntityId<Shell["sourceTurnId"]>(r.sourceTurnId),
    gatewayOperationId: (r.gatewayOperationId ?? null) as Shell["gatewayOperationId"],
    gatewayOperationIndex: (r.gatewayOperationIndex ?? null) as Shell["gatewayOperationIndex"],
    subagentAgentId: r.subagentAgentId as Shell["subagentAgentId"],
    subagentNickname: r.subagentNickname as Shell["subagentNickname"],
    subagentRole: r.subagentRole as Shell["subagentRole"],
    forkSourceThreadId: optionalNullableEntityId<Shell["forkSourceThreadId"]>(r.forkSourceThreadId),
    forkSourceMessageId: optionalNullableEntityId<Shell["forkSourceMessageId"]>(
      r.forkSourceMessageId,
    ),
    sidechatSourceThreadId: optionalNullableEntityId<Shell["sidechatSourceThreadId"]>(
      r.sidechatSourceThreadId,
    ),
    sidechatContext: optionalJsonColumn(r.sidechatContext, decodeSidechatContext),
    sidechatLastActivityAt: (r.sidechatLastActivityAt ?? null) as Shell["sidechatLastActivityAt"],
    sidechatExpiredAt: (r.sidechatExpiredAt ?? null) as Shell["sidechatExpiredAt"],
    lastKnownPr: decodeLastKnownPr(r.lastKnownPr),
    latestTurnId: nullableEntityId<Shell["latestTurnId"]>(r.latestTurnId),
    handoff: decodeHandoff(r.handoff),
    isProjectImport: r.isProjectImport as Shell["isProjectImport"],
    claudeCacheReview: optionalJsonColumn(r.claudeCacheReview, decodeClaudeCacheReview),
    goal: r.goal as Shell["goal"],
    goalStartedAt: (r.goalStartedAt ?? null) as Shell["goalStartedAt"],
    goalPausedAt: (r.goalPausedAt ?? null) as Shell["goalPausedAt"],
    latestUserMessageAt: r.latestUserMessageAt as Shell["latestUserMessageAt"],
    latestHumanMessageAt: r.latestHumanMessageAt as Shell["latestHumanMessageAt"],
    pendingApprovalCount: r.pendingApprovalCount as Shell["pendingApprovalCount"],
    pendingUserInputCount: r.pendingUserInputCount as Shell["pendingUserInputCount"],
    hasActionableProposedPlan: r.hasActionableProposedPlan as Shell["hasActionableProposedPlan"],
    createdAt: r.createdAt as Shell["createdAt"],
    updatedAt: r.updatedAt as Shell["updatedAt"],
    archivedAt: (r.archivedAt ?? null) as Shell["archivedAt"],
    settledAt: (r.settledAt ?? null) as Shell["settledAt"],
    usageLimitRecovery: optionalJsonColumn(r.usageLimitRecovery, decodeUsageLimitRecovery),
    usageLimitRecoverySource: optionalJsonColumn(
      r.usageLimitRecoverySource,
      decodeUsageLimitRecoverySource,
    ),
    usageLimitRecoveryCancelledAt:
      r.usageLimitRecoveryCancelledAt as Shell["usageLimitRecoveryCancelledAt"],
    usageLimitRecoveryCancelledTurnId: optionalNullableEntityId<
      Shell["usageLimitRecoveryCancelledTurnId"]
    >(r.usageLimitRecoveryCancelledTurnId),
    usageLimitRecoveryLastResetAt:
      r.usageLimitRecoveryLastResetAt as Shell["usageLimitRecoveryLastResetAt"],
    snoozedUntil: (r.snoozedUntil ?? null) as Shell["snoozedUntil"],
    snoozeReminderAt: (r.snoozeReminderAt ?? null) as Shell["snoozeReminderAt"],
    deletedAt: r.deletedAt as Shell["deletedAt"],
  };
}

type Full = ProjectionThreadDbRowRaw;

function mapFullColumns(row: DbRow): Full {
  const r = row as { readonly [K in keyof Full]: unknown };
  return {
    ...mapShellColumns(row),
    pinnedMessages: decodePinnedMessages(r.pinnedMessages),
    notes: r.notes as Full["notes"],
    goalAchievements: decodeGoalAchievements(r.goalAchievements ?? null),
  };
}

/** Maps one row, or returns `undefined` when only the schema decode can produce the exact result. */
export function mapProjectionThreadShellDbRow(row: DbRow): Shell | undefined {
  return mapOrUndefined(row, mapShellColumns);
}

/** Maps one row, or returns `undefined` when only the schema decode can produce the exact result. */
export function mapProjectionThreadDbRow(row: DbRow): Full | undefined {
  return mapOrUndefined(row, mapFullColumns);
}

function mapOrUndefined<A>(row: DbRow, map: (row: DbRow) => A): A | undefined {
  try {
    return map(row);
  } catch (error) {
    if (error === NEEDS_SCHEMA_DECODE) {
      return undefined;
    }
    throw error;
  }
}

const makeBulkRowDecoder = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S & { readonly fields: Readonly<Record<string, unknown>> },
  map: (row: DbRow) => S["Type"],
) => {
  // Same decoder `SqlSchema.findAll` builds, so the fallback's result and error are unchanged.
  const decodeWithSchema = Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(schema)));
  const columns = Object.keys(schema.fields);
  return (rows: ReadonlyArray<unknown>): Effect.Effect<Array<S["Type"]>, Schema.SchemaError> =>
    Effect.suspend(() => {
      const first = rows[0] as DbRow | undefined;
      // Rows of one statement share a column set; a missing column means the
      // schema's defaults or its missing-key failure apply, which only it knows.
      if (first !== undefined && !columns.every((column) => column in first)) {
        return decodeWithSchema(rows);
      }
      try {
        return Effect.succeed(rows.map((row) => map(row as DbRow)));
      } catch (error) {
        if (error === NEEDS_SCHEMA_DECODE) {
          return decodeWithSchema(rows);
        }
        throw error;
      }
    });
};

/**
 * Decodes every row of a bulk `projection_threads` shell read. Equivalent to
 * `SqlSchema.findAll`'s decode with {@link ProjectionThreadShellDbRowSchema}.
 */
export const decodeProjectionThreadShellDbRows = makeBulkRowDecoder(
  ProjectionThreadShellDbRowSchema,
  mapShellColumns,
);

/**
 * Decodes every row of a bulk `projection_threads` full-row read. Equivalent to
 * `SqlSchema.findAll`'s decode with {@link ProjectionThreadDbRowSchema}.
 */
export const decodeProjectionThreadDbRows = makeBulkRowDecoder(
  ProjectionThreadDbRowSchema,
  mapFullColumns,
);
