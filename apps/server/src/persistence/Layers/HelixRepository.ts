import { HelixHandoff, HelixPair, isHelixHandoffActive } from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  HelixRepository,
  HelixRepositoryError,
  type HelixAutomaticTurn,
  type HelixRepositoryErrorCode,
  type HelixRepositoryShape,
} from "../Services/HelixRepository";

interface PairRow {
  readonly pairId: string;
  readonly projectId: string;
  readonly leadThreadId: string;
  readonly builderThreadId: string;
  readonly builderCreatedAt: string | null;
  readonly lifecycle: string;
  readonly revision: number;
  readonly cancellationEpoch: number;
  readonly holdJson: string | null;
  readonly goalJson: string;
  readonly configJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface HandoffRow {
  readonly recordJson: string;
}

const decodePairUnknown = Schema.decodeUnknownEffect(HelixPair);
const decodeHandoff = Schema.decodeUnknownEffect(Schema.fromJsonString(HelixHandoff));

const fail = (code: HelixRepositoryErrorCode, message: string, existingHandoffId?: string) =>
  Effect.fail(
    new HelixRepositoryError({
      code,
      message,
      ...(existingHandoffId === undefined ? {} : { existingHandoffId }),
    }),
  );

const storageError = (cause: unknown) =>
  cause instanceof HelixRepositoryError
    ? cause
    : new HelixRepositoryError({
        code: "storage",
        message: "Could not persist Helix state.",
        cause,
      });

const decodePairRow = (row: PairRow) =>
  Effect.try({
    try: () => ({
      id: row.pairId,
      projectId: row.projectId,
      leadThreadId: row.leadThreadId,
      builderThreadId: row.builderThreadId,
      builderCreatedAt: row.builderCreatedAt,
      lifecycle: row.lifecycle,
      revision: row.revision,
      cancellationEpoch: row.cancellationEpoch,
      hold: row.holdJson === null ? null : (JSON.parse(row.holdJson) as unknown),
      goal: JSON.parse(row.goalJson) as unknown,
      config: JSON.parse(row.configJson) as unknown,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }),
    catch: (cause) => cause,
  }).pipe(Effect.flatMap(decodePairUnknown));

export const makeHelixRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const pairColumns = sql`
    pair_id AS "pairId",
    project_id AS "projectId",
    lead_thread_id AS "leadThreadId",
    builder_thread_id AS "builderThreadId",
    builder_created_at AS "builderCreatedAt",
    lifecycle,
    revision,
    cancellation_epoch AS "cancellationEpoch",
    hold_json AS "holdJson",
    goal_json AS "goalJson",
    config_json AS "configJson",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const readPairWhere = (
    column: "pair_id" | "lead_thread_id" | "builder_thread_id",
    value: string,
  ) =>
    (column === "pair_id"
      ? sql<PairRow>`SELECT ${pairColumns} FROM helix_pairs WHERE pair_id = ${value}`
      : column === "lead_thread_id"
        ? sql<PairRow>`SELECT ${pairColumns} FROM helix_pairs WHERE lead_thread_id = ${value}`
        : sql<PairRow>`SELECT ${pairColumns} FROM helix_pairs WHERE builder_thread_id = ${value}`
    ).pipe(Effect.flatMap((rows) => (rows[0] ? decodePairRow(rows[0]) : Effect.succeed(null))));

  const insertRetired = (threadId: string, pairId: string) => sql`
    INSERT INTO helix_retired_threads (thread_id, pair_id, retired_at)
    VALUES (${threadId}, ${pairId}, ${new Date().toISOString()})
    ON CONFLICT (thread_id) DO NOTHING
  `;

  const readHandoffs = (rows: ReadonlyArray<HandoffRow>) =>
    Effect.forEach(rows, (row) => decodeHandoff(row.recordJson));

  const readHandoff = (handoffId: string) =>
    sql<HandoffRow>`
      SELECT record_json AS "recordJson" FROM helix_handoffs WHERE handoff_id = ${handoffId}
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0] ? decodeHandoff(rows[0].recordJson) : Effect.succeed(null),
      ),
    );

  const insertHandoffRow = (handoff: HelixHandoff) => sql`
    INSERT INTO helix_handoffs (
      handoff_id, pair_id, sequence, request_id, request_fingerprint, work_item_id,
      previous_handoff_id, correction_index, goal_seq, epoch, state, delivery, revision,
      dispatch_command_id, wake_command_id, builder_turn_id, record_json, created_at, updated_at
    ) VALUES (
      ${handoff.id}, ${handoff.pairId}, ${handoff.sequence}, ${handoff.requestId},
      ${handoff.requestFingerprint}, ${handoff.workItemId}, ${handoff.previousHandoffId},
      ${handoff.correctionIndex}, ${handoff.goalSeq}, ${handoff.epoch}, ${handoff.state},
      ${handoff.delivery}, ${handoff.revision}, ${handoff.dispatch?.commandId ?? null},
      ${handoff.wake?.commandId ?? null}, ${handoff.builderTurnId}, ${JSON.stringify(handoff)},
      ${handoff.createdAt}, ${handoff.updatedAt}
    )
  `;

  const assertNoOtherActiveHandoff = (pairId: string, handoffId: string) =>
    sql<{ readonly handoffId: string }>`
      SELECT handoff_id AS "handoffId" FROM helix_handoffs
      WHERE pair_id = ${pairId} AND handoff_id <> ${handoffId}
        AND state IN ('prepared', 'dispatching', 'running')
      LIMIT 1
    `.pipe(
      Effect.flatMap((rows) =>
        rows[0]
          ? fail(
              "active_handoff_exists",
              "This pair already has a prepared, dispatching or running handoff.",
              rows[0].handoffId,
            )
          : Effect.void,
      ),
    );

  const repository: HelixRepositoryShape = {
    createPair: (pair) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (pair.revision !== 0) {
              return yield* fail("stale_revision", "A new Helix pair starts at revision 0.");
            }
            const participants = [pair.leadThreadId, pair.builderThreadId];
            const [taken] = yield* sql<{ readonly pairId: string }>`
              SELECT pair_id AS "pairId" FROM helix_pairs
              WHERE pair_id = ${pair.id}
                OR lead_thread_id IN ${sql.in(participants)}
                OR builder_thread_id IN ${sql.in(participants)}
              LIMIT 1
            `;
            if (taken) {
              return yield* fail(
                "participant_conflict",
                "A thread can belong to at most one Helix pair, in one role.",
              );
            }
            yield* sql`
              INSERT INTO helix_pairs (
                pair_id, project_id, lead_thread_id, builder_thread_id, builder_created_at,
                lifecycle, revision, cancellation_epoch, hold_json, goal_json, config_json,
                created_at, updated_at
              ) VALUES (
                ${pair.id}, ${pair.projectId}, ${pair.leadThreadId}, ${pair.builderThreadId},
                ${pair.builderCreatedAt}, ${pair.lifecycle}, ${pair.revision},
                ${pair.cancellationEpoch}, ${pair.hold === null ? null : JSON.stringify(pair.hold)},
                ${JSON.stringify(pair.goal)}, ${JSON.stringify(pair.config)},
                ${pair.createdAt}, ${pair.updatedAt}
              )
            `;
            const stored = yield* readPairWhere("pair_id", pair.id);
            return stored ?? (yield* fail("storage", "The new Helix pair could not be read back."));
          }),
        )
        .pipe(Effect.mapError(storageError)),

    getPair: (pairId) => readPairWhere("pair_id", pairId).pipe(Effect.mapError(storageError)),

    getPairByLeadThread: (threadId) =>
      readPairWhere("lead_thread_id", threadId).pipe(Effect.mapError(storageError)),

    getParticipant: (threadId) =>
      Effect.gen(function* () {
        const asLead = yield* readPairWhere("lead_thread_id", threadId);
        if (asLead) return { pair: asLead, role: "lead" as const };
        const asBuilder = yield* readPairWhere("builder_thread_id", threadId);
        return asBuilder ? { pair: asBuilder, role: "builder" as const } : null;
      }).pipe(Effect.mapError(storageError)),

    listPairsTolerant: () =>
      sql<PairRow>`SELECT ${pairColumns} FROM helix_pairs ORDER BY created_at, pair_id`.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodePairRow(row).pipe(
              Effect.map((pair) => ({ ok: true as const, pair })),
              Effect.catch(() => Effect.succeed({ ok: false as const, row })),
            ),
          ),
        ),
        Effect.map((decoded) => ({
          pairs: decoded.flatMap((entry) => (entry.ok ? [entry.pair] : [])),
          invalid: decoded.flatMap((entry) =>
            entry.ok
              ? []
              : [
                  {
                    pairId: entry.row.pairId,
                    leadThreadId: entry.row.leadThreadId,
                    builderThreadId: entry.row.builderThreadId,
                  },
                ],
          ),
        })),
        Effect.mapError(storageError),
      ),

    listPairs: () =>
      sql<PairRow>`SELECT ${pairColumns} FROM helix_pairs ORDER BY created_at, pair_id`.pipe(
        Effect.flatMap((rows) => Effect.forEach(rows, decodePairRow)),
        Effect.mapError(storageError),
      ),

    commit: ({ pair, expectedRevision, handoffs }) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            if (pair.revision !== expectedRevision + 1) {
              return yield* fail("stale_revision", "Helix pair revisions must advance by one.");
            }
            const updated = yield* sql<{ readonly pairId: string }>`
              UPDATE helix_pairs SET
                project_id = ${pair.projectId},
                builder_thread_id = ${pair.builderThreadId},
                builder_created_at = ${pair.builderCreatedAt},
                lifecycle = ${pair.lifecycle},
                revision = ${pair.revision},
                cancellation_epoch = ${pair.cancellationEpoch},
                hold_json = ${pair.hold === null ? null : JSON.stringify(pair.hold)},
                goal_json = ${JSON.stringify(pair.goal)},
                config_json = ${JSON.stringify(pair.config)},
                updated_at = ${pair.updatedAt}
              WHERE pair_id = ${pair.id} AND revision = ${expectedRevision}
                AND lead_thread_id = ${pair.leadThreadId}
              RETURNING pair_id AS "pairId"
            `;
            if (updated.length === 0) {
              const current = yield* readPairWhere("pair_id", pair.id);
              return yield* current === null
                ? fail("not_found", "This Helix pair no longer exists.")
                : fail(
                    "stale_revision",
                    `This Helix pair changed (revision ${current.revision}). Reload and retry.`,
                  );
            }

            for (const write of handoffs) {
              const handoff = write.handoff;
              if (handoff.pairId !== pair.id) {
                return yield* fail("storage", "A handoff can only be written with its own pair.");
              }
              if (write.kind === "insert") {
                const existing = yield* sql<{
                  readonly handoffId: string;
                  readonly fingerprint: string;
                }>`
                  SELECT handoff_id AS "handoffId", request_fingerprint AS "fingerprint"
                  FROM helix_handoffs
                  WHERE pair_id = ${handoff.pairId} AND request_id = ${handoff.requestId}
                `;
                if (existing[0]) {
                  return yield* existing[0].fingerprint === handoff.requestFingerprint
                    ? fail(
                        "duplicate_request",
                        "This request id already created a handoff with the same content.",
                        existing[0].handoffId,
                      )
                    : fail(
                        "request_conflict",
                        "This request id already belongs to a handoff with different content.",
                        existing[0].handoffId,
                      );
                }
                if (handoff.revision !== 0) {
                  return yield* fail(
                    "stale_handoff_revision",
                    "A new Helix handoff starts at revision 0.",
                  );
                }
                if (isHelixHandoffActive(handoff.state)) {
                  yield* assertNoOtherActiveHandoff(handoff.pairId, handoff.id);
                }
                yield* insertHandoffRow(handoff);
                continue;
              }
              if (handoff.revision !== write.expectedRevision + 1) {
                return yield* fail(
                  "stale_handoff_revision",
                  "Helix handoff revisions must advance by one.",
                );
              }
              if (isHelixHandoffActive(handoff.state)) {
                yield* assertNoOtherActiveHandoff(handoff.pairId, handoff.id);
              }
              const changed = yield* sql<{ readonly handoffId: string }>`
                UPDATE helix_handoffs SET
                  state = ${handoff.state},
                  delivery = ${handoff.delivery},
                  revision = ${handoff.revision},
                  dispatch_command_id = ${handoff.dispatch?.commandId ?? null},
                  wake_command_id = ${handoff.wake?.commandId ?? null},
                  builder_turn_id = ${handoff.builderTurnId},
                  record_json = ${JSON.stringify(handoff)},
                  updated_at = ${handoff.updatedAt}
                WHERE handoff_id = ${handoff.id} AND pair_id = ${handoff.pairId}
                  AND revision = ${write.expectedRevision}
                  AND request_id = ${handoff.requestId}
                  AND request_fingerprint = ${handoff.requestFingerprint}
                RETURNING handoff_id AS "handoffId"
              `;
              if (changed.length === 0) {
                return yield* fail(
                  "stale_handoff_revision",
                  "This Helix handoff changed or does not exist. Reload and retry.",
                );
              }
            }

            const storedPair = yield* readPairWhere("pair_id", pair.id);
            if (storedPair === null) {
              return yield* fail("not_found", "This Helix pair no longer exists.");
            }
            const storedHandoffs = yield* Effect.forEach(handoffs, (write) =>
              readHandoff(write.handoff.id).pipe(
                Effect.flatMap((handoff) =>
                  handoff === null
                    ? fail("storage", "A committed handoff could not be read back.")
                    : Effect.succeed(handoff),
                ),
              ),
            );
            return { pair: storedPair, handoffs: storedHandoffs };
          }),
        )
        .pipe(Effect.mapError(storageError)),

    getHandoff: (handoffId) => readHandoff(handoffId).pipe(Effect.mapError(storageError)),

    findHandoffByRequestId: (pairId, requestId) =>
      sql<HandoffRow>`
        SELECT record_json AS "recordJson" FROM helix_handoffs
        WHERE pair_id = ${pairId} AND request_id = ${requestId}
      `.pipe(
        Effect.flatMap((rows) =>
          rows[0] ? decodeHandoff(rows[0].recordJson) : Effect.succeed(null),
        ),
        Effect.mapError(storageError),
      ),

    listHandoffs: (pairId, options) =>
      sql<HandoffRow>`
        SELECT record_json AS "recordJson" FROM helix_handoffs
        WHERE pair_id = ${pairId}
        ORDER BY sequence DESC
        LIMIT ${Math.max(0, Math.min(options?.limit ?? 1_000, 1_000))}
      `.pipe(Effect.flatMap(readHandoffs), Effect.mapError(storageError)),

    listHandoffsTolerant: (pairId) =>
      sql<HandoffRow & { readonly handoffId: string }>`
        SELECT handoff_id AS "handoffId", record_json AS "recordJson" FROM helix_handoffs
        WHERE pair_id = ${pairId}
        ORDER BY sequence DESC
      `.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeHandoff(row.recordJson).pipe(
              Effect.map((handoff) => ({ ok: true as const, handoff })),
              Effect.catch(() => Effect.succeed({ ok: false as const, handoffId: row.handoffId })),
            ),
          ),
        ),
        Effect.map((decoded) => ({
          handoffs: decoded.flatMap((entry) => (entry.ok ? [entry.handoff] : [])),
          invalid: decoded.flatMap((entry) => (entry.ok ? [] : [entry.handoffId])),
        })),
        Effect.mapError(storageError),
      ),

    listUnresolvedHandoffsTolerant: () =>
      sql<HandoffRow & { readonly pairId: string }>`
        SELECT pair_id AS "pairId", record_json AS "recordJson" FROM helix_handoffs
        WHERE state IN ('prepared', 'dispatching', 'running', 'awaiting_review')
          OR delivery IN ('pending', 'wake_requested')
        ORDER BY pair_id, sequence
      `.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            decodeHandoff(row.recordJson).pipe(
              Effect.map((handoff) => ({ ok: true as const, handoff })),
              Effect.catch(() => Effect.succeed({ ok: false as const, pairId: row.pairId })),
            ),
          ),
        ),
        Effect.map((decoded) => ({
          handoffs: decoded.flatMap((entry) => (entry.ok ? [entry.handoff] : [])),
          invalidPairIds: [
            ...new Set(decoded.flatMap((entry) => (entry.ok ? [] : [entry.pairId]))),
          ],
        })),
        Effect.mapError(storageError),
      ),

    listUnresolvedHandoffs: () =>
      sql<HandoffRow>`
        SELECT record_json AS "recordJson" FROM helix_handoffs
        WHERE state IN ('prepared', 'dispatching', 'running', 'awaiting_review')
          OR delivery IN ('pending', 'wake_requested')
        ORDER BY pair_id, sequence
      `.pipe(Effect.flatMap(readHandoffs), Effect.mapError(storageError)),

    findAutomaticTurn: (commandId) =>
      Effect.gen(function* () {
        const rows = yield* sql<HandoffRow & { readonly kind: string }>`
          SELECT record_json AS "recordJson", 'dispatch' AS kind FROM helix_handoffs
          WHERE dispatch_command_id = ${commandId}
          UNION ALL
          SELECT record_json AS "recordJson", 'wake' AS kind FROM helix_handoffs
          WHERE wake_command_id = ${commandId}
          LIMIT 1
        `;
        const row = rows[0];
        if (!row) return null;
        const handoff = yield* decodeHandoff(row.recordJson);
        const pair = yield* readPairWhere("pair_id", handoff.pairId);
        if (pair === null) return null;
        const turn: HelixAutomaticTurn = {
          kind: row.kind === "wake" ? "wake" : "dispatch",
          pair,
          handoff,
        };
        return turn;
      }).pipe(Effect.mapError(storageError)),

    deletePair: (pairId, options) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            // Retire first, in the same transaction: a Builder never loses its
            // restriction between the pair row going and the retirement row landing.
            for (const threadId of options?.retireThreadIds ?? []) {
              yield* insertRetired(threadId, pairId);
            }
            yield* sql`DELETE FROM helix_handoffs WHERE pair_id = ${pairId}`;
            yield* sql`DELETE FROM helix_pairs WHERE pair_id = ${pairId}`;
            yield* sql`DELETE FROM helix_stop_requests WHERE pair_id = ${pairId}`;
          }),
        )
        .pipe(Effect.mapError(storageError)),

    retireThread: (threadId, pairId) =>
      insertRetired(threadId, pairId).pipe(Effect.asVoid, Effect.mapError(storageError)),

    claimMessageEffect: (messageId, effect) =>
      sql<{ readonly messageId: string }>`
        INSERT INTO helix_applied_messages (message_id, effect, applied_at)
        VALUES (${messageId}, ${effect}, ${new Date().toISOString()})
        ON CONFLICT (message_id, effect) DO NOTHING
        RETURNING message_id AS "messageId"
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(storageError),
      ),

    hasMessageEffect: (messageId, effect) =>
      sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId" FROM helix_applied_messages
        WHERE message_id = ${messageId} AND effect = ${effect}
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(storageError),
      ),

    recordStopRequest: (pairId) =>
      sql`
        INSERT INTO helix_stop_requests (pair_id, requested_at)
        VALUES (${pairId}, ${new Date().toISOString()})
        ON CONFLICT (pair_id) DO NOTHING
      `.pipe(Effect.asVoid, Effect.mapError(storageError)),

    clearStopRequest: (pairId) =>
      sql`DELETE FROM helix_stop_requests WHERE pair_id = ${pairId}`.pipe(
        Effect.asVoid,
        Effect.mapError(storageError),
      ),

    listStopRequests: () =>
      sql<{ readonly pairId: string }>`
        SELECT pair_id AS "pairId" FROM helix_stop_requests ORDER BY requested_at
      `.pipe(
        Effect.map((rows) => rows.map((row) => row.pairId)),
        Effect.mapError(storageError),
      ),

    listRetiredThreads: () =>
      sql<{ readonly threadId: string; readonly pairId: string }>`
        SELECT thread_id AS "threadId", pair_id AS "pairId" FROM helix_retired_threads
        ORDER BY retired_at, thread_id
      `.pipe(Effect.mapError(storageError)),
  };
  return repository;
});

export const HelixRepositoryLive = Layer.effect(HelixRepository, makeHelixRepository);
