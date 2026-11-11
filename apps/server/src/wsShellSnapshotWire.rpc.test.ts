/**
 * subscribeShell through the server's real RPC group, handler map and
 * admission middleware, on the production runtime composition with an
 * in-memory database. Frames are captured the way the WebSocket protocol
 * writes them (`RpcSerialization.json`).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ORCHESTRATION_WS_METHODS,
  OrchestrationThreadPullRequest,
  PendingClaudeCacheReview,
  ThreadHandoff,
  ThreadSidechatContext,
  UsageLimitRecovery,
  UsageLimitRecoverySource,
  WS_METHODS,
  WsOrchestrationSubscribeShellRpc,
  type OrchestrationShellSnapshot,
} from "@synara/contracts";
import { Duration, Effect, Layer, Queue, Schema, Scope } from "effect";
import { FastCheck } from "effect/testing";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "./config";
import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "./managedAttachmentPrincipal";
import { OpenLive } from "./open";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import {
  RemoteSessionRegistry,
  RemoteSessionRegistryService,
} from "./remoteSessions/sessionRegistry";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import { ServerSettingsService } from "./serverSettings";
import {
  makeWsConnectionSessions,
  WS_CONNECTION_SESSION_HEADER,
  WsConnectionSessions,
} from "./wsConnectionSessions";
import { admittedWsFeatureRpcGroupForTest, makeWsRpcLayer } from "./wsRpc";

const at = (second: number) => `2026-09-01T00:00:${String(second % 60).padStart(2, "0")}.000Z`;

const jsonSamples = (schema: Schema.Top, count: number, seed: number): string[] => {
  const encode = Schema.encodeUnknownSync(
    Schema.fromJsonString(schema as unknown as Schema.Codec<unknown, unknown>),
  );
  return FastCheck.sample(Schema.toArbitrary(schema), { numRuns: count, seed }).map(
    (value) => encode(value) as string,
  );
};

/** Threads covering archived, deleted, null and populated JSON, and every optional column. */
const seedShell = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const modelSelections = [
    '{"provider":"codex","model":"gpt-5-codex"}',
    '{"provider":"claudeAgent","instanceId":"claude-work","model":"claude-opus","options":{"effort":"high"}}',
    '{"model":"legacy-without-provider"}',
  ];
  yield* sql`INSERT INTO projection_spaces (space_id, name, icon, sort_order, created_at, updated_at)
    VALUES ('space-wire', 'Wire', 'bag', 0, ${at(0)}, ${at(0)})`;
  for (const [index, [id, defaultModel, folders]] of [
    ["project-plain", null, "[]"],
    ["project-model", modelSelections[1]!, '["/tmp/extra"]'],
  ].entries()) {
    yield* sql`INSERT INTO projection_projects
      (project_id, title, workspace_root, default_model_selection_json, scripts_json,
       is_pinned, space_id, additional_folders_json, created_at, updated_at)
      VALUES (${id}, ${id}, ${`/tmp/${id}`}, ${defaultModel}, '[]', ${index}, 'space-wire',
        ${folders}, ${at(1)}, ${at(1)})`;
  }
  const json: Record<string, string[]> = {
    handoff_json: jsonSamples(ThreadHandoff, 12, 1),
    last_known_pr_json: jsonSamples(OrchestrationThreadPullRequest, 12, 2),
    sidechat_context_json: jsonSamples(ThreadSidechatContext, 12, 3),
    claude_cache_review_json: jsonSamples(PendingClaudeCacheReview, 12, 4),
    usage_limit_recovery_json: jsonSamples(UsageLimitRecovery, 12, 5),
    usage_limit_recovery_source_json: jsonSamples(UsageLimitRecoverySource, 12, 6),
  };
  const ids: string[] = [];
  for (let index = 0; index < 36; index++) {
    const id = `thread-${String(index).padStart(2, "0")}`;
    ids.push(id);
    const full = index % 3 === 0;
    const pick = (column: string) => (index % 2 === 0 ? json[column]![index % 12]! : null);
    yield* sql`INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        env_mode, branch, worktree_path, working_directory, associated_worktree_path,
        associated_worktree_branch, associated_worktree_ref, create_branch_flow_completed,
        is_pinned, parent_thread_id, creation_source, source_thread_id, source_turn_id,
        gateway_operation_id, gateway_operation_index, subagent_agent_id, subagent_nickname,
        subagent_role, fork_source_thread_id, fork_source_message_id, sidechat_source_thread_id,
        sidechat_context_json, sidechat_last_activity_at, sidechat_expired_at,
        last_known_pr_json, latest_turn_id, handoff_json, claude_cache_review_json, goal,
        goal_started_at, goal_paused_at, latest_user_message_at, latest_human_message_at,
        pending_approval_count, pending_user_input_count, has_actionable_proposed_plan,
        created_at, updated_at, archived_at, settled_at, usage_limit_recovery_source_json,
        usage_limit_recovery_json, usage_limit_recovery_cancelled_at,
        usage_limit_recovery_cancelled_turn_id, usage_limit_recovery_last_reset_at,
        snoozed_until, snooze_reminder_at, deleted_at
      ) VALUES (
        ${id}, ${index % 2 === 0 ? "project-plain" : "project-model"}, ${`Thread ${index}`},
        ${modelSelections[index % 3]!}, 'approval-required', ${index % 2 === 0 ? "default" : "plan"},
        ${full ? "worktree" : "local"}, ${full ? "feature/x" : null}, ${full ? "/tmp/wt" : null},
        ${full ? "/tmp/wt/sub" : null}, ${full ? "/tmp/assoc" : null}, ${full ? "assoc" : null},
        ${full ? "refs/heads/assoc" : null}, ${full ? 1 : 0}, ${index % 4 === 0 ? 1 : 0},
        ${full ? "thread-00" : null}, ${full ? "provider_native" : null},
        ${full ? "thread-01" : null}, ${full ? "turn-source" : null}, ${full ? "op-1" : null},
        ${full ? index : null}, ${full ? "agent-1" : null}, ${full ? "Nick" : null},
        ${full ? "reviewer" : null}, ${full ? "thread-02" : null}, ${full ? "message-fork" : null},
        ${full ? "thread-03" : null}, ${pick("sidechat_context_json")}, ${full ? at(5) : null},
        ${full ? at(6) : null}, ${pick("last_known_pr_json")}, ${full ? `turn-${id}` : null},
        ${pick("handoff_json")}, ${pick("claude_cache_review_json")},
        ${full ? "Ship it" : index % 5 === 0 ? "" : null},
        ${full ? at(7) : null}, ${full ? at(8) : null}, ${full ? at(9) : null}, ${full ? at(10) : null},
        ${index % 2}, ${index % 3 === 1 ? 2 : 0}, ${index % 4 === 1 ? 1 : 0},
        ${at(index)}, ${at(index + 1)}, ${index % 5 === 1 ? at(20) : null}, ${full ? at(21) : null},
        ${pick("usage_limit_recovery_source_json")}, ${pick("usage_limit_recovery_json")},
        ${full ? at(22) : null}, ${full ? "turn-cancelled" : null}, ${full ? at(23) : null},
        ${full ? at(24) : null}, ${full ? at(25) : null}, ${index % 7 === 6 ? at(30) : null}
      )`;
    if (full) {
      yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, pending_message_id, assistant_message_id, state, requested_at,
         started_at, completed_at, checkpoint_turn_count, checkpoint_status, checkpoint_files_json)
        VALUES (${id}, ${`turn-${id}`}, NULL, ${`message-${id}`}, 'completed', ${at(11)},
          ${at(12)}, ${at(13)}, 1, 'ready', '[]')`;
      yield* sql`INSERT INTO projection_thread_sessions
        (thread_id, status, provider_name, runtime_mode, active_turn_id, last_error, updated_at,
         last_activity_at, last_progress_at, provider_instance_id)
        VALUES (${id}, 'running', 'codex', 'full-access', ${`turn-${id}`}, 'boom', ${at(14)},
          ${at(15)}, ${at(16)}, 'codex')`;
    }
  }
  return ids.filter((_, index) => index % 7 !== 6);
});

/** Contract encode of one snapshot chunk, as the RPC layer wrote it before the swap. */
function contractChunkFrame(requestId: string, snapshot: OrchestrationShellSnapshot): string {
  const success = (
    WsOrchestrationSubscribeShellRpc.successSchema as unknown as { readonly success: Schema.Top }
  ).success;
  const encodeChunk = Schema.encodeUnknownSync(
    Schema.toCodecJson(Schema.Array(success as Schema.Codec<unknown, unknown>)),
  );
  return RpcSerialization.json.makeUnsafe().encode({
    _tag: "Chunk",
    requestId,
    values: encodeChunk([{ kind: "snapshot", snapshot }]),
  }) as string;
}

const runtimeLayer = Layer.empty.pipe(
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(makeServerRuntimeServicesLayer()),
  Layer.provideMerge(makeServerProviderLayer()),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "synara-shell-wire-rpc-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
);

interface Connection {
  readonly frames: ReadonlyArray<string>;
  readonly request: (id: string, tag: string, payload?: unknown) => Effect.Effect<void>;
  readonly waitFor: (predicate: (frame: string) => boolean, label: string) => Effect.Effect<string>;
}

/**
 * Serves `AdmittedWsFeatureRpcGroup` with the real handler layer, behind an
 * in-memory protocol for client 0, authenticated as the local owner.
 */
const connect = (
  patchQuery: (query: ProjectionSnapshotQuery["Service"]) => ProjectionSnapshotQuery["Service"] = (
    query,
  ) => query,
) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const sessions = yield* makeWsConnectionSessions;
    const handlers = yield* Layer.buildWithScope(
      makeWsRpcLayer().pipe(
        Layer.provide(
          Layer.effect(
            ProjectionSnapshotQuery,
            Effect.map(ProjectionSnapshotQuery.asEffect(), patchQuery),
          ),
        ),
        Layer.provideMerge(Layer.succeed(WsConnectionSessions, sessions)),
        Layer.provideMerge(
          Layer.succeed(RemoteSessionRegistryService, new RemoteSessionRegistry()),
        ),
        Layer.provideMerge(runtimeLayer),
      ),
      scope,
    );
    const sessionKey = yield* sessions
      .register({ role: "owner", attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL })
      .pipe(Scope.provide(scope));
    const parser = RpcSerialization.json.makeUnsafe();
    const frames: string[] = [];
    let write: ((clientId: number, message: unknown) => Effect.Effect<void>) | undefined;
    const protocol = yield* RpcServer.Protocol.make((writeRequest) => {
      write = writeRequest as typeof write;
      return Effect.gen(function* () {
        return {
          disconnects: yield* Queue.unbounded<number>(),
          send: (_clientId: number, response: unknown) =>
            Effect.sync(() => {
              frames.push(parser.encode(response) as string);
            }),
          end: () => Effect.void,
          clientIds: Effect.succeed(new Set([0])),
          initialMessage: Effect.succeedNone,
          supportsAck: false,
          supportsTransferables: false,
          supportsSpanPropagation: false,
        };
      });
    });
    // Same options as production (wsRpc.ts toHttpEffectWebsocket): fatal defects stay on.
    yield* RpcServer.make(admittedWsFeatureRpcGroupForTest, { disableTracing: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(handlers),
      Effect.forkIn(scope),
    );
    const connection: Connection = {
      frames,
      request: (id, tag, payload = {}) =>
        write!(0, {
          _tag: "Request",
          id,
          tag,
          payload,
          headers: [[WS_CONNECTION_SESSION_HEADER, sessionKey]],
        }),
      waitFor: (predicate, label) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 1_000; attempt++) {
            const frame = frames.find(predicate);
            if (frame !== undefined) return frame;
            // A connection-level Defect fails every request: stop waiting.
            const defect = frames.find((candidate) => candidate.startsWith('{"_tag":"Defect"'));
            if (defect !== undefined) {
              return yield* Effect.die(
                new Error(`connection defect while waiting for ${label}: ${defect}`),
              );
            }
            yield* Effect.sleep(Duration.millis(10));
          }
          return yield* Effect.die(
            new Error(`timed out waiting for ${label}: ${frames.join("\n")}`),
          );
        }),
    };
    return { connection, handlers };
  });

const parse = (frame: string) => JSON.parse(frame) as Record<string, unknown>;
const isFrame = (tag: string, requestId?: string) => (frame: string) => {
  const message = parse(frame);
  return message._tag === tag && (requestId === undefined || message.requestId === requestId);
};

// makeWsRpcLayer's handler map leaves its requirements typed as `any`; the
// runtime layer above provides them, and a missing one fails at layer build.
const runScoped = (effect: Effect.Effect<void, unknown, any>) =>
  Effect.runPromise(Effect.scoped(effect) as Effect.Effect<void, unknown, never>);

describe("subscribeShell through the real RPC group and handler", () => {
  it("writes the snapshot chunk the contract encode wrote, archived threads included", async () => {
    await runScoped(
      Effect.gen(function* () {
        const { connection, handlers } = yield* connect();
        const expectedIds = yield* seedShell.pipe(Effect.provide(handlers));
        const snapshot = yield* Effect.flatMap(ProjectionSnapshotQuery.asEffect(), (query) =>
          query.getShellSnapshot(),
        ).pipe(Effect.provide(handlers));
        expect(snapshot.threads.map((thread) => thread.id)).toEqual(expectedIds);
        expect(snapshot.threads.some((thread) => thread.archivedAt !== null)).toBe(true);

        yield* connection.request("1", ORCHESTRATION_WS_METHODS.subscribeShell);
        const chunk = yield* connection.waitFor(isFrame("Chunk", "1"), "shell snapshot chunk");
        expect(chunk).toBe(contractChunkFrame("1", snapshot));
        expect(connection.frames.some(isFrame("Defect"))).toBe(false);
      }),
    );
  }, 60_000);

  it("fails only the shell request when the snapshot cannot be encoded", async () => {
    // A decoded-typed snapshot whose model-selection option the JSON codec rejects.
    const unencodable = (query: ProjectionSnapshotQuery["Service"]) => ({
      ...query,
      getShellSnapshot: () =>
        query.getShellSnapshot().pipe(
          Effect.map((snapshot) => ({
            ...snapshot,
            threads: snapshot.threads.map((thread, index) =>
              index === 0
                ? {
                    ...thread,
                    modelSelection: {
                      ...thread.modelSelection,
                      options: { reasoningEffort: undefined },
                    } as unknown as typeof thread.modelSelection,
                  }
                : thread,
            ),
          })),
        ),
    });
    await runScoped(
      Effect.gen(function* () {
        const { connection, handlers } = yield* connect(unencodable);
        yield* seedShell.pipe(Effect.provide(handlers));

        // An in-flight stream on the same connection, then the failing shell request.
        yield* connection.request("1", WS_METHODS.subscribeServerLifecycle);
        yield* connection.request("2", ORCHESTRATION_WS_METHODS.subscribeShell);
        const exit = parse(yield* connection.waitFor(isFrame("Exit", "2"), "shell exit")) as {
          exit: {
            _tag: string;
            cause: ReadonlyArray<{ _tag: string; error?: { _tag?: string; message?: string } }>;
          };
        };
        expect(exit.exit._tag).toBe("Failure");
        expect(exit.exit.cause).toEqual([
          expect.objectContaining({
            _tag: "Fail",
            error: expect.objectContaining({ _tag: "WsRpcError" }),
          }),
        ]);
        expect(connection.frames.some(isFrame("Defect"))).toBe(false);
        expect(connection.frames.some(isFrame("Exit", "1"))).toBe(false);

        // The connection keeps serving requests.
        yield* connection.request("3", WS_METHODS.serverGetSettings);
        const settings = parse(
          yield* connection.waitFor(isFrame("Exit", "3"), "settings exit"),
        ) as { exit: { _tag: string } };
        expect(settings.exit._tag).toBe("Success");
        expect(connection.frames.some(isFrame("Exit", "1"))).toBe(false);
        expect(connection.frames.some(isFrame("Defect"))).toBe(false);
      }),
    );
  }, 60_000);
});
