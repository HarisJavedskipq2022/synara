/**
 * Helix end to end through the production composition: the real WebSocket
 * RPC handlers and admission, orchestration engine, provider command reactor,
 * provider service with its runtime journal and ingestion, agent gateway with
 * real credentials and the MCP transport, and the real Helix coordinator
 * layer over SQLite. The only fake is a scripted provider adapter, registered
 * for Codex and Claude, that acquires real gateway credentials and calls the
 * gateway's MCP handler with them.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  HELIX_WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  RuntimeRequestId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
} from "@synara/contracts";
import { Duration, Effect, Fiber, Layer, PubSub, Queue, Scope, Stream } from "effect";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";

import { acquireAgentGatewaySessionLease } from "../agentGateway/sessionLease";
import { AgentGateway } from "../agentGateway/Services/AgentGateway";
import { AgentGatewayCredentials } from "../agentGateway/Services/AgentGatewayCredentials";
import { ServerConfig, deriveServerPaths } from "../config";
import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "../managedAttachmentPrincipal";
import { OpenLive } from "../open";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery";
import { layerConfig as SqlitePersistenceFromConfig } from "../persistence/Layers/Sqlite";
import { HelixRepository } from "../persistence/Services/HelixRepository";
import { ProviderAdapterValidationError, type ProviderAdapterError } from "../provider/Errors";
import type { ProviderAdapterShape } from "../provider/Services/ProviderAdapter";
import { ClaudeAdapter } from "../provider/Services/ClaudeAdapter";
import { CodexAdapter } from "../provider/Services/CodexAdapter";
import { ProviderHelixRoleResolverLive } from "../provider/Services/ProviderHelixRoleResolver";
import { ProviderService } from "../provider/Services/ProviderService";
import {
  RemoteSessionRegistry,
  RemoteSessionRegistryService,
} from "../remoteSessions/sessionRegistry";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "../serverLayers";
import { ServerSettingsLive, ServerSettingsService } from "../serverSettings";
import { startServerRuntimePipeline } from "../effectServer";
import { OrchestrationReactor } from "../orchestration/Services/OrchestrationReactor";
import { reconcileRestartStuckTurns } from "../orchestration/startupTurnReconciliation";
import { ProjectionPendingInteractionRepositoryLive } from "../persistence/Layers/ProjectionPendingInteractions";
import { ProviderSessionRuntimeRepositoryLive } from "../persistence/Layers/ProviderSessionRuntime";
import { ServerRuntimeStartup } from "../serverRuntimeStartup";
import {
  makeWsConnectionSessions,
  WS_CONNECTION_SESSION_HEADER,
  WsConnectionSessions,
} from "../wsConnectionSessions";
import { admittedWsFeatureRpcGroupForTest, makeWsRpcLayer } from "../wsRpc";

// ── Scripted provider ───────────────────────────────────────────────────

interface TurnContext {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly input: string;
  readonly provider: ProviderKind;
  /** Call a Synara gateway tool with this session's real credential. */
  readonly callTool: (name: string, args: Record<string, unknown>) => Effect.Effect<ToolOutcome>;
  readonly say: (text: string) => Effect.Effect<void>;
  readonly complete: (state?: "completed" | "failed") => Effect.Effect<void>;
  readonly requestApproval: (requestId: string) => Effect.Effect<void>;
}

interface ToolOutcome {
  readonly isError: boolean;
  readonly json: Record<string, unknown>;
}

type TurnScript = (ctx: TurnContext) => Effect.Effect<void>;

interface StartRecord {
  readonly provider: ProviderKind;
  readonly threadId: string;
  readonly input: ProviderSessionStartInput;
  readonly sessionSerial: number;
}

/** Shared by both scripted adapters and the test body; survives a rebuild of the layers. */
class Provider {
  readonly starts: StartRecord[] = [];
  readonly sends: Array<{
    threadId: string;
    input: string;
    turnId: string;
    sessionSerial: number;
  }> = [];
  readonly interrupts: Array<{ threadId: string; turnId: string | undefined }> = [];
  readonly approvals: Array<{ threadId: string; requestId: string; decision: string }> = [];
  readonly tokens = new Map<string, string>();
  /** Per-thread scripts, consumed in order; a turn without one completes with "ok". */
  readonly scripts = new Map<string, TurnScript[]>();
  /** Scripts for the next turn whose input contains the key. */
  readonly byInput: Array<{ readonly contains: string; readonly script: TurnScript }> = [];
  gateway: { readonly handleMcpPost: AgentGateway["Service"]["handleMcpPost"] } | null = null;
  snapshot: ProjectionSnapshotQuery["Service"] | null = null;
  /** Runs inside sendTurn after the send is recorded, before the turn id is returned. */
  beforeSendReturns: ((threadId: string, turnId: string) => Effect.Effect<void>) | null = null;
  /** Each adapter's way to lose a live session, as a crashed provider process would. */
  readonly sessionDroppers: Array<(threadId: string) => void> = [];

  sendsTo(threadId: string) {
    return this.sends.filter((send) => send.threadId === threadId);
  }
  startsFor(threadId: string) {
    return this.starts.filter((start) => start.threadId === threadId);
  }
  script(threadId: string, script: TurnScript) {
    const list = this.scripts.get(threadId) ?? [];
    list.push(script);
    this.scripts.set(threadId, list);
  }
}

let sessionSerial = 0;

/** The live session is back at rest once its running turn ends. */
function settleSession(state: { session: ProviderSession }, turnId: string) {
  if (state.session.activeTurnId !== turnId) return;
  const { activeTurnId: _settled, ...rest } = state.session;
  state.session = { ...rest, status: "ready", updatedAt: new Date().toISOString() };
}

const makeScriptedAdapter = (provider: "codex" | "claudeAgent", world: Provider) =>
  Effect.gen(function* () {
    const credentials = yield* AgentGatewayCredentials;
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<
      string,
      {
        session: ProviderSession;
        generation: string | undefined;
        serial: number;
        turns: number;
        running: Map<string, Fiber.Fiber<void>>;
        release: () => void;
      }
    >();
    const emit = (
      threadId: string,
      generation: string | undefined,
      event: Record<string, unknown>,
    ) =>
      PubSub.publish(events, {
        eventId: EventId.makeUnsafe(randomUUID()),
        provider,
        createdAt: new Date().toISOString(),
        threadId,
        sessionId: RuntimeSessionId.makeUnsafe(threadId),
        ...(generation !== undefined ? { lifecycleGeneration: generation } : {}),
        ...event,
      } as unknown as ProviderRuntimeEvent).pipe(Effect.asVoid);

    const callTool =
      (threadId: string) =>
      (name: string, args: Record<string, unknown>): Effect.Effect<ToolOutcome> =>
        Effect.gen(function* () {
          const gateway = world.gateway!;
          const token = world.tokens.get(threadId)!;
          const response = yield* gateway.handleMcpPost({
            authorizationHeader: `Bearer ${token}`,
            body: {
              jsonrpc: "2.0",
              id: randomUUID(),
              method: "tools/call",
              params: { name, arguments: args },
            },
          });
          const result = (response.body as { result?: Record<string, unknown> } | undefined)
            ?.result;
          const text = (result?.content as Array<{ text: string }> | undefined)?.[0]?.text ?? "{}";
          return { isError: result?.isError === true, json: JSON.parse(text) };
        });

    const waitForRunningTurn = (threadId: string, turnId: string) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 500; attempt++) {
          const shell = yield* world
            .snapshot!.getThreadShellById(ThreadId.makeUnsafe(threadId))
            .pipe(Effect.orDie);
          const latest = shell._tag === "Some" ? shell.value.latestTurn : null;
          if (latest?.turnId === turnId && latest.state === "running") return;
          yield* Effect.sleep(Duration.millis(10));
        }
        return yield* Effect.die(new Error(`turn ${turnId} never projected as running`));
      });

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession: (input) =>
        Effect.sync(() => {
          sessionSerial += 1;
          const lease = acquireAgentGatewaySessionLease(
            credentials,
            input.threadId,
            provider,
            input,
          );
          if (lease) world.tokens.set(input.threadId, lease.connection.bearerToken);
          world.starts.push({ provider, threadId: input.threadId, input, sessionSerial });
          const now = new Date().toISOString();
          const session: ProviderSession = {
            provider,
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            resumeCursor: { threadId: input.threadId, serial: sessionSerial },
            createdAt: now,
            updatedAt: now,
          };
          sessions.get(input.threadId)?.release();
          sessions.set(input.threadId, {
            session,
            generation: input.lifecycleGeneration,
            serial: sessionSerial,
            turns: 0,
            running: new Map(),
            release: () => lease?.release(),
          });
          return session;
        }),
      sendTurn: (input) =>
        Effect.gen(function* () {
          const state = sessions.get(input.threadId);
          if (!state) {
            return yield* new ProviderAdapterValidationError({
              provider,
              operation: "sendTurn",
              issue: "no session",
            });
          }
          state.turns += 1;
          const turnId = TurnId.makeUnsafe(`${provider}-${state.serial}-turn-${state.turns}`);
          // Like a real adapter, the live session reports its running turn.
          state.session = {
            ...state.session,
            status: "running",
            activeTurnId: turnId,
            updatedAt: new Date().toISOString(),
          };
          const text = input.input ?? "";
          world.sends.push({
            threadId: input.threadId,
            input: text,
            turnId,
            sessionSerial: state.serial,
          });
          const byInput = world.byInput.findIndex((entry) => text.includes(entry.contains));
          const script =
            byInput >= 0
              ? world.byInput.splice(byInput, 1)[0]!.script
              : (world.scripts.get(input.threadId)?.shift() ?? ((ctx) => ctx.complete()));
          const generation = state.generation;
          const ctx: TurnContext = {
            threadId: input.threadId,
            turnId,
            input: text,
            provider,
            callTool: callTool(input.threadId),
            say: (message) =>
              Effect.gen(function* () {
                yield* emit(input.threadId, generation, {
                  type: "content.delta",
                  turnId,
                  itemId: `item-${turnId}`,
                  payload: { streamKind: "assistant_text", delta: message },
                });
                yield* emit(input.threadId, generation, {
                  type: "item.completed",
                  turnId,
                  itemId: `item-${turnId}`,
                  payload: { itemType: "assistant_message", status: "completed" },
                });
              }),
            complete: (outcome = "completed") =>
              Effect.gen(function* () {
                state.running.delete(turnId);
                settleSession(state, turnId);
                yield* emit(input.threadId, generation, {
                  type: "turn.completed",
                  turnId,
                  payload: { state: outcome },
                });
              }),
            requestApproval: (requestId) =>
              emit(input.threadId, generation, {
                type: "request.opened",
                turnId,
                requestId: RuntimeRequestId.makeUnsafe(requestId),
                payload: { requestType: "command_execution_approval", detail: "Run tests" },
              }),
          };
          if (world.beforeSendReturns) yield* world.beforeSendReturns(input.threadId, turnId);
          yield* emit(input.threadId, generation, { type: "turn.started", turnId, payload: {} });
          const fiber = yield* waitForRunningTurn(input.threadId, turnId).pipe(
            Effect.andThen(script(ctx)),
            Effect.catchCause((cause) => Effect.logError("scripted turn failed", cause)),
            Effect.forkDetach,
          );
          state.running.set(turnId, fiber);
          return { threadId: input.threadId, turnId };
        }),
      interruptTurn: (threadId, turnId) =>
        Effect.gen(function* () {
          world.interrupts.push({ threadId, turnId });
          const state = sessions.get(threadId);
          if (!state) return;
          for (const [running, fiber] of state.running) {
            if (turnId !== undefined && running !== turnId) continue;
            state.running.delete(running);
            settleSession(state, running);
            yield* Fiber.interrupt(fiber).pipe(Effect.forkDetach);
            yield* emit(threadId, state.generation, {
              type: "turn.completed",
              turnId: running,
              payload: { state: "interrupted" },
            });
          }
        }),
      respondToRequest: (threadId, requestId, decision: ProviderApprovalDecision) =>
        Effect.gen(function* () {
          world.approvals.push({ threadId, requestId, decision });
          const state = sessions.get(threadId);
          yield* emit(threadId, state?.generation, {
            type: "request.resolved",
            requestId: RuntimeRequestId.makeUnsafe(requestId),
            payload: { requestType: "command_execution_approval", decision },
          });
        }),
      respondToUserInput: () => Effect.void,
      stopSession: (threadId) =>
        Effect.sync(() => {
          sessions.get(threadId)?.release();
          sessions.delete(threadId);
        }),
      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values(), (entry) => entry.session)),
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
      rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
      stopAll: () =>
        Effect.sync(() => {
          for (const entry of sessions.values()) entry.release();
          sessions.clear();
        }),
      streamEvents: Stream.fromPubSub(events),
    };
    world.sessionDroppers.push((threadId) => {
      sessions.get(threadId)?.release();
      sessions.delete(threadId);
    });
    return adapter;
  });

// ── Composition ─────────────────────────────────────────────────────────

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

interface World {
  readonly provider: Provider;
  readonly baseDir: string;
  readonly repoDir: string;
  readonly worktreeDir: string;
  readonly setupMarker: string;
}

function makeWorld(options: { readonly enableHelix: boolean }): World {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synara-helix-it-")));
  const baseDir = path.join(root, "home");
  const repoDir = path.join(root, "repo");
  const worktreeDir = path.join(root, "worktree");
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "-q", "-b", "main");
  git(
    repoDir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  git(repoDir, "worktree", "add", "-q", "-b", "feature/helix", worktreeDir);
  const { settingsPath } = Effect.runSync(
    deriveServerPaths(baseDir, undefined).pipe(Effect.provide(NodeServices.layer)),
  );
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ enableHelix: options.enableHelix }));
  return {
    provider: new Provider(),
    baseDir,
    repoDir,
    worktreeDir,
    setupMarker: path.join(root, "setup-ran"),
  };
}

const runtimeLayerFor = (world: World) =>
  Layer.empty.pipe(
    Layer.provideMerge(OpenLive),
    Layer.provideMerge(makeServerRuntimeServicesLayer()),
    Layer.provideMerge(
      makeServerProviderLayer({
        testAdapterLayers: {
          codex: Layer.effect(
            CodexAdapter,
            makeScriptedAdapter("codex", world.provider).pipe(
              Effect.map((adapter) => adapter as CodexAdapter["Service"]),
            ),
          ),
          claudeAgent: Layer.effect(
            ClaudeAdapter,
            makeScriptedAdapter("claudeAgent", world.provider).pipe(
              Effect.map((adapter) => adapter as ClaudeAdapter["Service"]),
            ),
          ),
        },
      }).pipe(
        // One shared resolver, as in makeServerApplicationLayers: Helix registers, ProviderService reads.
        Layer.provideMerge(ProviderHelixRoleResolverLive),
      ),
    ),
    // The same ServerSettingsLive reference the runtime layer uses: one instance, read from disk.
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(SqlitePersistenceFromConfig),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), world.baseDir).pipe(Layer.provide(NodeServices.layer)),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

interface Connection {
  readonly call: (tag: string, payload?: unknown) => Effect.Effect<RpcOutcome>;
  readonly stream: (tag: string, payload: unknown) => Effect.Effect<() => ReadonlyArray<unknown>>;
  readonly dispatch: (command: Record<string, unknown>) => Effect.Effect<RpcOutcome>;
}

interface RpcOutcome {
  readonly ok: boolean;
  readonly value: unknown;
  readonly errorCode: string | undefined;
  readonly errorMessage: string | undefined;
}

/** Serve the real admitted RPC group over an in-memory protocol, as the local owner. */
const connect = (world: World) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const sessions = yield* makeWsConnectionSessions;
    const handlers = yield* Layer.buildWithScope(
      makeWsRpcLayer().pipe(
        Layer.provideMerge(Layer.succeed(WsConnectionSessions, sessions)),
        Layer.provideMerge(
          Layer.succeed(RemoteSessionRegistryService, new RemoteSessionRegistry()),
        ),
        Layer.provideMerge(runtimeLayerFor(world)),
      ),
      scope,
    );
    const services = yield* Effect.gen(function* () {
      return {
        gateway: yield* AgentGateway,
        snapshot: yield* ProjectionSnapshotQuery,
        credentials: yield* AgentGatewayCredentials,
        helix: yield* HelixRepository,
        providerService: yield* ProviderService,
      };
    }).pipe(Effect.provide(handlers));
    world.provider.gateway = services.gateway;
    world.provider.snapshot = services.snapshot;
    // The server's own startup sequence (effectServer.ts): reactors, restart
    // reconciliation, then command admission.
    yield* Effect.gen(function* () {
      yield* (yield* ServerSettingsService).start;
      yield* startServerRuntimePipeline({
        orchestrationReactor: yield* OrchestrationReactor,
        reconcileRestartStuckTurns: reconcileRestartStuckTurns.pipe(
          Effect.provide(ProjectionPendingInteractionRepositoryLive),
          Effect.provide(ProviderSessionRuntimeRepositoryLive),
        ),
        reactors: [],
        subscriptionsScope: scope,
      });
      yield* (yield* ServerRuntimeStartup).markCommandReady;
    }).pipe(Effect.provide(handlers));
    const sessionKey = yield* sessions
      .register({ role: "owner", attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL })
      .pipe(Scope.provide(scope));
    // A second, non-owner session on the same server (a paired client or remote device).
    const clientSessionKey = yield* sessions
      .register({ role: "client", attachmentPrincipal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL })
      .pipe(Scope.provide(scope));
    const parser = RpcSerialization.json.makeUnsafe();
    const frames: Array<Record<string, unknown>> = [];
    let write: ((clientId: number, message: unknown) => Effect.Effect<void>) | undefined;
    const protocol = yield* RpcServer.Protocol.make((writeRequest) => {
      write = writeRequest as typeof write;
      return Effect.gen(function* () {
        return {
          disconnects: yield* Queue.unbounded<number>(),
          send: (_clientId: number, response: unknown) =>
            Effect.sync(() => {
              frames.push(JSON.parse(parser.encode(response) as string));
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
    yield* RpcServer.make(admittedWsFeatureRpcGroupForTest, { disableTracing: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(handlers),
      Effect.forkIn(scope),
    );
    let nextId = 0;
    const sendAs = (key: string) => (tag: string, payload: unknown) =>
      Effect.gen(function* () {
        nextId += 1;
        const id = String(nextId);
        yield* write!(0, {
          _tag: "Request",
          id,
          tag,
          payload,
          headers: [[WS_CONNECTION_SESSION_HEADER, key]],
        });
        return id;
      });
    const send = sendAs(sessionKey);
    const callAs =
      (key: string): Connection["call"] =>
      (tag, payload = {}) =>
        Effect.gen(function* () {
          const id = yield* sendAs(key)(tag, payload);
          for (let attempt = 0; attempt < 3_000; attempt++) {
            const exit = frames.find((frame) => frame._tag === "Exit" && frame.requestId === id) as
              | {
                  exit: {
                    _tag: string;
                    value?: unknown;
                    cause?: Array<{ error?: Record<string, unknown> }>;
                  };
                }
              | undefined;
            if (exit) {
              const error = exit.exit.cause?.[0]?.error;
              return {
                ok: exit.exit._tag === "Success",
                value: exit.exit.value,
                errorCode: error?.code as string | undefined,
                errorMessage: error?.message as string | undefined,
              };
            }
            if (frames.some((frame) => frame._tag === "Defect")) {
              return yield* Effect.die(new Error(`defect: ${JSON.stringify(frames.at(-1))}`));
            }
            yield* Effect.sleep(Duration.millis(10));
          }
          return yield* Effect.die(new Error(`no response to ${tag}`));
        });
    const call = callAs(sessionKey);
    const clientCall = callAs(clientSessionKey);
    const clientConnection: Pick<Connection, "call" | "dispatch"> = {
      call: clientCall,
      dispatch: (command) =>
        clientCall(ORCHESTRATION_WS_METHODS.dispatchCommand, {
          commandId: `client:${randomUUID()}`,
          createdAt: new Date().toISOString(),
          ...command,
        }),
    };
    const connection: Connection = {
      call,
      dispatch: (command) =>
        call(ORCHESTRATION_WS_METHODS.dispatchCommand, {
          commandId: `client:${randomUUID()}`,
          createdAt: new Date().toISOString(),
          ...command,
        }),
      stream: (tag, payload) =>
        Effect.gen(function* () {
          const id = yield* send(tag, payload);
          return () =>
            frames
              .filter((frame) => frame._tag === "Chunk" && frame.requestId === id)
              .flatMap((frame) => frame.values as unknown[]);
        }),
    };
    return { connection, clientConnection, services };
  });

const waitUntil = (label: string, condition: () => boolean | Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_500; attempt++) {
      const value = condition();
      if (typeof value === "boolean" ? value : yield* value) return;
      yield* Effect.sleep(Duration.millis(20));
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

const runScoped = (effect: Effect.Effect<void, unknown, any>) =>
  Effect.runPromise(Effect.scoped(effect) as Effect.Effect<void, unknown, never>);

const listTools = (world: World, threadId: string) =>
  Effect.gen(function* () {
    const response = yield* world.provider.gateway!.handleMcpPost({
      authorizationHeader: `Bearer ${world.provider.tokens.get(threadId)}`,
      body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    return (
      (response.body as { result?: { tools?: Array<{ name: string }> } }).result?.tools ?? []
    ).map((tool) => tool.name);
  });

const LEAD = "helix-it-lead";
const PROJECT = "helix-it-project";
const NEIGHBOUR = "helix-it-neighbour";

/** Project, Lead thread in a real git worktree, one plain user turn on the Lead. */
const seedLead = (world: World, connection: Connection) =>
  Effect.gen(function* () {
    const created = yield* connection.dispatch({
      type: "project.create",
      projectId: PROJECT,
      title: "Helix IT",
      workspaceRoot: world.repoDir,
    });
    expect(created.errorMessage).toBeUndefined();
    yield* connection.dispatch({
      type: "project.meta.update",
      projectId: PROJECT,
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: `touch ${world.setupMarker}`,
          icon: "play",
          runOnWorktreeCreate: true,
        },
      ],
    });
    const lead = yield* connection.dispatch({
      type: "thread.create",
      threadId: LEAD,
      projectId: PROJECT,
      title: "Lead chat",
      modelSelection: { provider: "claudeAgent", model: "sonnet" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      envMode: "worktree",
      branch: "feature/helix",
      worktreePath: world.worktreeDir,
    });
    expect(lead.errorMessage).toBeUndefined();
  });

const userTurn = (
  connection: Connection,
  threadId: string,
  text: string,
  extra: Record<string, unknown> = {},
) =>
  connection.dispatch({
    type: "thread.turn.start",
    threadId,
    message: { messageId: `user:${randomUUID()}`, role: "user", text, attachments: [] },
    runtimeMode: "approval-required",
    interactionMode: "default",
    ...extra,
  });

const pairOf = (services: { helix: HelixRepository["Service"] }) =>
  services.helix.getPairByLeadThread(ThreadId.makeUnsafe(LEAD)).pipe(
    Effect.orDie,
    Effect.map((pair) => pair!),
  );

const latestHandoff = (services: { helix: HelixRepository["Service"] }) =>
  Effect.gen(function* () {
    const pair = yield* pairOf(services);
    // Undefined until the first handoff exists; callers that poll must allow it.
    return (yield* services.helix.listHandoffs(pair.id).pipe(Effect.orDie))[0]!;
  });

const enableHelix = (connection: Connection) =>
  connection.call(HELIX_WS_METHODS.enable, {
    leadThreadId: LEAD,
    builderModelSelection: { provider: "codex", model: "gpt-5" },
  });

const BRIEF = {
  title: "Login form",
  objective: "Add the login form.",
  acceptanceCriteria: "Works.",
};

// ── Tests ───────────────────────────────────────────────────────────────

describe("Helix through the production composition", () => {
  it("enables, delegates, reports, corrects on the same Builder session, wakes once, accepts", async () => {
    const world = makeWorld({ enableHelix: true });
    const provider = world.provider;
    await runScoped(
      Effect.gen(function* () {
        const { connection, services } = yield* connect(world);
        yield* seedLead(world, connection);

        // 1. An ordinary first turn: no Helix role, no Helix tools.
        yield* userTurn(connection, LEAD, "hello");
        yield* waitUntil("first lead turn", () => provider.sendsTo(LEAD).length === 1);
        expect(provider.startsFor(LEAD)[0]!.input).not.toHaveProperty("helixRole");
        expect((yield* listTools(world, LEAD)).some((name) => name.startsWith("helix_"))).toBe(
          false,
        );

        const enabled = yield* enableHelix(connection);
        expect(enabled.errorMessage).toBeUndefined();
        const pair = yield* pairOf(services);
        expect(pair.lifecycle).toBe("active");

        // 2. The next Lead turn restarts the session with its role; the Lead delegates.
        let delegateOutcome: ToolOutcome | null = null;
        provider.script(LEAD, (ctx) =>
          Effect.gen(function* () {
            delegateOutcome = yield* ctx.callTool("helix_delegate", {
              requestId: "first",
              brief: BRIEF,
              waitSeconds: 30,
            });
            yield* ctx.say("Delegated.");
            yield* ctx.complete();
          }),
        );
        let builderMidTurn: { state: string; hasResult: boolean } | null = null;
        provider.script(pair.builderThreadId, (ctx) =>
          Effect.gen(function* () {
            const report = yield* ctx.callTool("helix_report", {
              outcome: "completed",
              summary: "Login form added",
              verification: "bun run test",
            });
            expect(report.isError).toBe(false);
            const midTurn = yield* latestHandoff(services);
            builderMidTurn = { state: midTurn.state, hasResult: midTurn.result !== null };
            yield* ctx.say("Report filed.");
            yield* ctx.complete();
          }),
        );
        yield* userTurn(connection, LEAD, "build the login form");
        yield* waitUntil("lead restarted with role", () => provider.startsFor(LEAD).length === 2);
        expect(provider.startsFor(LEAD)[1]!.input.helixRole?.role).toBe("lead");
        const leadTools = yield* listTools(world, LEAD);
        expect(leadTools.filter((name) => name.startsWith("helix_")).toSorted()).toEqual([
          "helix_delegate",
          "helix_inspect",
          "helix_review",
          "helix_wait",
        ]);

        yield* waitUntil("delegate returned", () => delegateOutcome !== null);
        const delegated = delegateOutcome! as ToolOutcome;
        expect(delegated.isError).toBe(false);
        expect(delegated.json.timedOut).toBe(false);
        expect((delegated.json.handoff as { delivery: string }).delivery).toBe("returned_in_tool");
        expect((delegated.json.handoff as { result: { summary: string } }).result.summary).toBe(
          "Login form added",
        );
        // The report alone never finalised the result: the turn had to settle first.
        expect(builderMidTurn).toEqual({ state: "running", hasResult: false });

        // The Builder: in the Lead's worktree and branch, not a sub-agent, no new worktree, no setup.
        const builder = yield* services.snapshot
          .getThreadShellById(pair.builderThreadId)
          .pipe(Effect.orDie);
        expect(builder._tag).toBe("Some");
        if (builder._tag === "Some") {
          expect(builder.value.worktreePath).toBe(world.worktreeDir);
          expect(builder.value.branch).toBe("feature/helix");
          expect(builder.value.parentThreadId).toBeNull();
        }
        expect(git(world.repoDir, "worktree", "list").trim().split("\n")).toHaveLength(2);
        expect(fs.existsSync(world.setupMarker)).toBe(false);
        const builderStart = provider.startsFor(pair.builderThreadId);
        expect(builderStart).toHaveLength(1);
        expect(builderStart[0]!.input.helixRole?.role).toBe("builder");
        expect(builderStart[0]!.input.cwd).toBe(world.worktreeDir);
        expect(yield* listTools(world, pair.builderThreadId)).toEqual(["helix_report"]);
        const firstBrief = provider.sendsTo(pair.builderThreadId)[0]!;
        expect(firstBrief.input).toContain("Add the login form.");
        const briefMessages = yield* services.snapshot
          .getThreadDetailById(pair.builderThreadId)
          .pipe(Effect.orDie);
        if (briefMessages._tag === "Some") {
          expect(
            briefMessages.value.messages.find((message) => message.role === "user")?.dispatchOrigin,
          ).toBe("agent");
        }

        // 3/4. Timeout path on a correction: the review's wait expires, then the Lead is woken once.
        const first = yield* latestHandoff(services);
        let reviewOutcome: ToolOutcome | null = null;
        let releaseBuilder: (() => void) | null = null;
        provider.script(LEAD, (ctx) =>
          Effect.gen(function* () {
            reviewOutcome = yield* ctx.callTool("helix_review", {
              handoffId: first.id,
              requestId: "review-1",
              verdict: "changes_requested",
              feedback: "Add the password field.",
              waitSeconds: 1,
            });
            yield* ctx.complete();
          }),
        );
        provider.script(pair.builderThreadId, (ctx) =>
          Effect.gen(function* () {
            yield* Effect.callback<void>((resume) => {
              releaseBuilder = () => resume(Effect.void);
            });
            yield* ctx.callTool("helix_report", {
              outcome: "completed",
              summary: "Password field added",
            });
            yield* ctx.say("Done again.");
            yield* ctx.complete();
          }),
        );
        let woken: ToolOutcome | null = null;
        provider.byInput.push({
          contains: "Helix: Builder result",
          script: (ctx) =>
            Effect.gen(function* () {
              woken = yield* ctx.callTool("helix_review", {
                handoffId: (yield* latestHandoff(services)).id,
                requestId: "review-2",
                verdict: "accepted",
              });
              yield* ctx.complete();
            }),
        });
        yield* userTurn(connection, LEAD, "please add a password field");
        yield* waitUntil("review returned", () => reviewOutcome !== null);
        const review = reviewOutcome! as ToolOutcome;
        expect(review.isError).toBe(false);
        expect((review.json.next as { timedOut: boolean }).timedOut).toBe(true);
        yield* waitUntil("second brief", () => provider.sendsTo(pair.builderThreadId).length === 2);
        const briefs = provider.sendsTo(pair.builderThreadId);
        expect(briefs[1]!.input).toContain("Add the password field.");
        // Same Builder thread and the same provider session.
        expect(briefs[1]!.sessionSerial).toBe(briefs[0]!.sessionSerial);
        expect(provider.startsFor(pair.builderThreadId)).toHaveLength(1);

        yield* waitUntil("lead turn ended", () =>
          services.snapshot.getThreadShellById(ThreadId.makeUnsafe(LEAD)).pipe(
            Effect.orDie,
            Effect.map(
              (shell) => shell._tag === "Some" && shell.value.latestTurn?.state !== "running",
            ),
          ),
        );
        yield* waitUntil("builder script waiting", () => releaseBuilder !== null);
        releaseBuilder!();
        yield* waitUntil("lead woken", () => woken !== null);
        const wakes = provider
          .sendsTo(LEAD)
          .filter((send) => send.input.includes("Helix: Builder result"));
        expect(wakes).toHaveLength(1);
        expect(wakes[0]!.input).toContain("Password field added");
        expect((woken! as ToolOutcome).isError).toBe(false);
        yield* waitUntil("accepted", () =>
          latestHandoff(services).pipe(Effect.map((handoff) => handoff?.state === "accepted")),
        );

        // A wait on the already woken handoff reports it as delivered, not as new.
        let rewait: ToolOutcome | null = null;
        provider.script(LEAD, (ctx) =>
          Effect.gen(function* () {
            rewait = yield* ctx.callTool("helix_wait", { waitSeconds: 0 });
            yield* ctx.complete();
          }),
        );
        yield* userTurn(connection, LEAD, "anything new?");
        yield* waitUntil("rewait", () => rewait !== null);
        const again = (rewait! as ToolOutcome).json;
        expect(again.message).toContain("Not a new result");
        // The Lead's review in its woken turn closed the delivery.
        expect((again.handoff as { delivery: string }).delivery).toBe("acknowledged");
        expect(
          provider.sendsTo(LEAD).filter((send) => send.input.includes("Helix: Builder result")),
        ).toHaveLength(1);
      }),
    );
  }, 120_000);

  for (const stopOn of ["lead", "builder"] as const) {
    it(`stops the pair from a user Stop on the ${stopOn} while a handoff runs`, async () => {
      const world = makeWorld({ enableHelix: true });
      const provider = world.provider;
      await runScoped(
        Effect.gen(function* () {
          const { connection, services } = yield* connect(world);
          yield* seedLead(world, connection);
          yield* enableHelix(connection);
          const pair = yield* pairOf(services);
          const events = yield* connection.stream(HELIX_WS_METHODS.subscribe, {
            leadThreadId: LEAD,
          });

          let delegated: ToolOutcome | null = null;
          provider.script(LEAD, (ctx) =>
            Effect.gen(function* () {
              delegated = yield* ctx.callTool("helix_delegate", {
                requestId: "stop",
                brief: BRIEF,
                waitSeconds: 30,
              });
              // Keeps working until interrupted.
              yield* Effect.never;
            }),
          );
          provider.script(pair.builderThreadId, (ctx) =>
            Effect.gen(function* () {
              yield* ctx.say("Halfway there.");
              yield* Effect.never;
            }),
          );
          yield* userTurn(connection, LEAD, "start");
          yield* waitUntil(
            "builder running",
            () => provider.sendsTo(pair.builderThreadId).length === 1,
          );
          yield* waitUntil("handoff running", () =>
            latestHandoff(services).pipe(Effect.map((handoff) => handoff?.state === "running")),
          );

          const target = stopOn === "lead" ? LEAD : pair.builderThreadId;
          const stop = yield* connection.dispatch({
            type: "thread.turn.interrupt",
            threadId: target,
          });
          expect(stop.errorMessage).toBeUndefined();
          yield* waitUntil(
            "both interrupted",
            () =>
              provider.interrupts.some((entry) => entry.threadId === LEAD) &&
              provider.interrupts.some((entry) => entry.threadId === pair.builderThreadId),
          );
          yield* waitUntil("delegate cancelled", () => delegated !== null);
          expect((delegated! as ToolOutcome).isError).toBe(true);
          const stopped = yield* pairOf(services);
          expect(stopped.hold?.kind).toBe("stop");
          expect(stopped.cancellationEpoch).toBe(1);
          // The interrupted Builder turn settles later: stored, never delivered.
          yield* waitUntil("late result recorded", () =>
            latestHandoff(services).pipe(Effect.map((handoff) => handoff?.lateResult !== null)),
          );
          const late = yield* latestHandoff(services);
          expect(late.state).toBe("interrupted");
          expect(late.delivery).toBe("suppressed");
          expect(
            provider.sendsTo(LEAD).filter((send) => send.input.includes("Helix: Builder result")),
          ).toHaveLength(0);
          yield* waitUntil("stream shows the hold", () =>
            events().some(
              (event) =>
                (event as { type: string; summary?: { hold?: { kind: string } } }).type ===
                  "pair-upserted" &&
                (event as { summary: { hold: { kind: string } | null } }).summary.hold?.kind ===
                  "stop",
            ),
          );

          // A user message to the Lead releases the hold and starts a new goal.
          yield* userTurn(connection, LEAD, "carry on");
          yield* waitUntil("hold released", () =>
            pairOf(services).pipe(Effect.map((current) => current.hold === null)),
          );
          // "start" began goal 1; this message begins goal 2.
          expect((yield* pairOf(services)).goal.seq).toBe(2);
        }),
      );
    }, 120_000);
  }

  it("a Stop landing between the brief's send and its bound turn id interrupts that turn", async () => {
    const world = makeWorld({ enableHelix: true });
    const provider = world.provider;
    await runScoped(
      Effect.gen(function* () {
        const { connection, services } = yield* connect(world);
        yield* seedLead(world, connection);
        yield* enableHelix(connection);
        const pair = yield* pairOf(services);
        let stoppedTurn: string | null = null;
        provider.beforeSendReturns = (threadId, turnId) =>
          threadId !== pair.builderThreadId || stoppedTurn !== null
            ? Effect.void
            : Effect.gen(function* () {
                stoppedTurn = turnId;
                // The user presses Stop while the provider is accepting the brief.
                const stopped = yield* connection.call(HELIX_WS_METHODS.stop, { pairId: pair.id });
                expect(stopped.errorMessage).toBeUndefined();
              });
        provider.script(LEAD, (ctx) =>
          Effect.gen(function* () {
            yield* ctx.callTool("helix_delegate", { requestId: "r", brief: BRIEF, waitSeconds: 0 });
            yield* ctx.complete();
          }),
        );
        provider.script(pair.builderThreadId, () => Effect.never);
        yield* userTurn(connection, LEAD, "start");
        yield* waitUntil("brief sent and stopped", () => stoppedTurn !== null);
        // Once the turn id is bound, the reactor sees the moved epoch and interrupts it.
        // The turn the provider just accepted ends interrupted. (The reactor handles
        // the Stop's own interrupt only after the send returns, so this outcome does
        // not isolate the post-bind check; the reactor unit test does.)
        yield* waitUntil("stale turn interrupted", () =>
          services.snapshot.getThreadShellById(pair.builderThreadId).pipe(
            Effect.orDie,
            Effect.map(
              (shell) =>
                shell._tag === "Some" &&
                shell.value.latestTurn?.turnId === stoppedTurn &&
                shell.value.latestTurn.state === "interrupted",
            ),
          ),
        );
        expect((yield* latestHandoff(services)).state).toBe("interrupted");
        expect((yield* pairOf(services)).hold?.kind).toBe("stop");
        yield* Effect.sleep(Duration.millis(300));
        expect(
          provider.sendsTo(LEAD).filter((send) => send.input.includes("Helix: Builder result")),
        ).toHaveLength(0);
        provider.beforeSendReturns = null;
      }),
    );
  }, 120_000);

  for (const workspace of ["worktree made by the first message", "local checkout"] as const) {
    it(`a new chat's first message turns Helix on (${workspace}): the first session already leads`, async () => {
      const world = makeWorld({ enableHelix: true });
      const provider = world.provider;
      const NEW = `helix-it-new-${workspace === "local checkout" ? "local" : "worktree"}`;
      await runScoped(
        Effect.gen(function* () {
          const { connection, services } = yield* connect(world);
          const created = yield* connection.dispatch({
            type: "project.create",
            projectId: PROJECT,
            title: "Helix IT",
            workspaceRoot: world.repoDir,
          });
          expect(created.errorMessage).toBeUndefined();
          // As the web does for a first message: create the chat (local), then, for
          // a worktree, move it to the worktree it just made, then send.
          const thread = yield* connection.dispatch({
            type: "thread.create",
            threadId: NEW,
            projectId: PROJECT,
            title: "New chat",
            modelSelection: { provider: "claudeAgent", model: "sonnet" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            envMode: "local",
            branch: null,
            worktreePath: null,
          });
          expect(thread.errorMessage).toBeUndefined();
          if (workspace === "worktree made by the first message") {
            const moved = yield* connection.dispatch({
              type: "thread.meta.update",
              threadId: NEW,
              envMode: "worktree",
              branch: "feature/helix",
              worktreePath: world.worktreeDir,
            });
            expect(moved.errorMessage).toBeUndefined();
          }
          let delegated: ToolOutcome | null = null;
          provider.script(NEW, (ctx) =>
            Effect.gen(function* () {
              delegated = yield* ctx.callTool("helix_delegate", {
                requestId: "first",
                brief: BRIEF,
                waitSeconds: 0,
              });
              yield* ctx.complete();
            }),
          );
          const sent = yield* userTurn(connection, NEW, "build it", {
            helix: { enabled: true, builderModelSelection: { provider: "codex", model: "gpt-5" } },
          });
          expect(sent.errorMessage).toBeUndefined();
          expect((sent.value as { helixPairing?: unknown }).helixPairing).toEqual({
            status: "applied",
          });
          yield* waitUntil("first turn delegated", () => delegated !== null);
          // One session start, already carrying the Lead role: no restart, no second message.
          expect(provider.startsFor(NEW)).toHaveLength(1);
          expect(provider.startsFor(NEW)[0]!.input.helixRole?.role).toBe("lead");
          expect((delegated! as ToolOutcome).isError).toBe(false);
          const leadTools = (yield* listTools(world, NEW)).filter((name) =>
            name.startsWith("helix_"),
          );
          expect(leadTools.toSorted()).toEqual([
            "helix_delegate",
            "helix_inspect",
            "helix_review",
            "helix_wait",
          ]);
          // The Builder works in the Lead's final workspace.
          const pair = yield* services.helix
            .getPairByLeadThread(ThreadId.makeUnsafe(NEW))
            .pipe(Effect.orDie);
          yield* waitUntil(
            "builder brief",
            () => provider.sendsTo(pair!.builderThreadId).length === 1,
          );
          const builder = yield* services.snapshot
            .getThreadShellById(pair!.builderThreadId)
            .pipe(Effect.orDie);
          const lead = yield* services.snapshot
            .getThreadShellById(ThreadId.makeUnsafe(NEW))
            .pipe(Effect.orDie);
          expect(builder._tag).toBe("Some");
          if (builder._tag === "Some" && lead._tag === "Some") {
            expect(builder.value.worktreePath).toBe(lead.value.worktreePath);
            expect(builder.value.workingDirectory).toBe(lead.value.workingDirectory);
            expect(builder.value.envMode).toBe(lead.value.envMode);
            if (workspace === "worktree made by the first message") {
              // The final worktree and branch, not the pre-creation local checkout.
              expect(builder.value.worktreePath).toBe(world.worktreeDir);
              expect(builder.value.branch).toBe("feature/helix");
            } else {
              // A local checkout: the project's own directory (the branch label is
              // the checkout's, filled in for the Lead by git status afterwards).
              expect(builder.value.worktreePath).toBeNull();
            }
          }
        }),
      );
    }, 120_000);
  }

  it("a pairing on a message with the setting off: the message is sent, Helix is not applied", async () => {
    const world = makeWorld({ enableHelix: false });
    const provider = world.provider;
    await runScoped(
      Effect.gen(function* () {
        const { connection, services } = yield* connect(world);
        yield* seedLead(world, connection);
        const sent = yield* userTurn(connection, LEAD, "hello", {
          helix: { enabled: true, builderModelSelection: { provider: "codex", model: "gpt-5" } },
        });
        expect(sent.errorMessage).toBeUndefined();
        expect(
          (sent.value as { helixPairing?: { status: string; reason?: string } }).helixPairing,
        ).toMatchObject({ status: "not_applied", reason: "setting_off" });
        yield* waitUntil("message sent", () => provider.sendsTo(LEAD).length === 1);
        expect(provider.startsFor(LEAD)[0]!.input).not.toHaveProperty("helixRole");
        expect(yield* services.helix.listPairs().pipe(Effect.orDie)).toHaveLength(0);
      }),
    );
  }, 120_000);

  it("an existing chat turns Helix on with a message: that message's turn restarts with the role", async () => {
    const world = makeWorld({ enableHelix: true });
    const provider = world.provider;
    await runScoped(
      Effect.gen(function* () {
        const { connection } = yield* connect(world);
        yield* seedLead(world, connection);
        yield* userTurn(connection, LEAD, "hello");
        yield* waitUntil("first turn", () => provider.sendsTo(LEAD).length === 1);
        expect(provider.startsFor(LEAD)[0]!.input).not.toHaveProperty("helixRole");
        const sent = yield* userTurn(connection, LEAD, "now with Helix", {
          helix: { enabled: true, builderModelSelection: { provider: "codex", model: "gpt-5" } },
        });
        expect((sent.value as { helixPairing?: unknown }).helixPairing).toEqual({
          status: "applied",
        });
        yield* waitUntil("second turn", () => provider.sendsTo(LEAD).length === 2);
        expect(provider.startsFor(LEAD)).toHaveLength(2);
        expect(provider.startsFor(LEAD)[1]!.input.helixRole?.role).toBe("lead");
      }),
    );
  }, 120_000);

  it("a non-owner session's message sends, but its pairing is not applied", async () => {
    const world = makeWorld({ enableHelix: true });
    const provider = world.provider;
    await runScoped(
      Effect.gen(function* () {
        const { connection, clientConnection, services } = yield* connect(world);
        yield* seedLead(world, connection);
        const sent = yield* userTurn(clientConnection as Connection, LEAD, "from a phone", {
          helix: { enabled: true, builderModelSelection: { provider: "codex", model: "gpt-5" } },
        });
        expect(sent.errorMessage).toBeUndefined();
        expect(
          (sent.value as { helixPairing?: { status: string; reason?: string } }).helixPairing,
        ).toMatchObject({ status: "not_applied", reason: "not_permitted" });
        yield* waitUntil("message sent", () => provider.sendsTo(LEAD).length === 1);
        expect(provider.startsFor(LEAD)[0]!.input).not.toHaveProperty("helixRole");
        expect(yield* services.helix.listPairs().pipe(Effect.orDie)).toHaveLength(0);
        // The same session is refused helix.enable outright, as before.
        const direct = yield* clientConnection.call(HELIX_WS_METHODS.enable, {
          leadThreadId: LEAD,
          builderModelSelection: { provider: "codex", model: "gpt-5" },
        });
        expect(direct.ok).toBe(false);
      }),
    );
  }, 120_000);

  it("never lets a server-queued wake reach the provider after Stop", async () => {
    const world = makeWorld({ enableHelix: true });
    const provider = world.provider;
    await runScoped(
      Effect.gen(function* () {
        const { connection, services } = yield* connect(world);
        yield* seedLead(world, connection);
        yield* enableHelix(connection);
        const pair = yield* pairOf(services);
        let releaseBuilder: (() => void) | null = null;
        provider.script(LEAD, (ctx) =>
          Effect.gen(function* () {
            yield* ctx.callTool("helix_delegate", { requestId: "q", brief: BRIEF, waitSeconds: 0 });
            // The Lead stays busy, so the wake queues behind this turn.
            yield* Effect.never;
          }),
        );
        provider.script(pair.builderThreadId, (ctx) =>
          Effect.gen(function* () {
            yield* Effect.callback<void>((resume) => {
              releaseBuilder = () => resume(Effect.void);
            });
            yield* ctx.say("Done.");
            yield* ctx.complete();
          }),
        );
        yield* userTurn(connection, LEAD, "start");
        yield* waitUntil("builder waiting", () => releaseBuilder !== null);
        releaseBuilder!();
        yield* waitUntil("wake queued", () =>
          latestHandoff(services).pipe(
            Effect.map((handoff) => handoff?.delivery === "wake_dispatched"),
          ),
        );
        const leadSendsBefore = provider.sendsTo(LEAD).length;
        yield* connection.dispatch({ type: "thread.turn.interrupt", threadId: LEAD });
        yield* waitUntil("wake suppressed", () =>
          latestHandoff(services).pipe(Effect.map((handoff) => handoff?.delivery === "suppressed")),
        );
        yield* Effect.sleep(Duration.millis(500));
        expect(provider.sendsTo(LEAD)).toHaveLength(leadSendsBefore);
        expect(
          provider.sendsTo(LEAD).some((send) => send.input.includes("Helix: Builder result")),
        ).toBe(false);
        // The Lead is not left looking busy.
        const lead = yield* services.snapshot
          .getThreadShellById(ThreadId.makeUnsafe(LEAD))
          .pipe(Effect.orDie);
        expect(lead._tag === "Some" && lead.value.session?.status).not.toBe("starting");
      }),
    );
  }, 120_000);

  it("refuses a user message typed into the Builder, while its approvals still round-trip", async () => {
    const world = makeWorld({ enableHelix: true });
    const provider = world.provider;
    await runScoped(
      Effect.gen(function* () {
        const { connection, services } = yield* connect(world);
        yield* seedLead(world, connection);
        yield* enableHelix(connection);
        const pair = yield* pairOf(services);
        provider.script(LEAD, (ctx) =>
          Effect.gen(function* () {
            yield* ctx.callTool("helix_delegate", { requestId: "a", brief: BRIEF, waitSeconds: 0 });
            yield* ctx.complete();
          }),
        );
        let approved = false;
        provider.script(pair.builderThreadId, (ctx) =>
          Effect.gen(function* () {
            yield* ctx.requestApproval("req-helix-1");
            yield* waitUntil("approval answered", () => provider.approvals.length > 0);
            approved = true;
            yield* ctx.complete();
          }),
        );
        yield* userTurn(connection, LEAD, "start");
        yield* waitUntil(
          "builder running",
          () => provider.sendsTo(pair.builderThreadId).length === 1,
        );

        const refused = yield* userTurn(connection, pair.builderThreadId, "let me help");
        expect(refused.ok).toBe(false);
        expect(refused.errorCode).toBe("HELIX_UNSUPPORTED_THREAD");
        expect(provider.sendsTo(pair.builderThreadId)).toHaveLength(1);

        yield* waitUntil("approval pending", () =>
          services.snapshot.getThreadShellById(pair.builderThreadId).pipe(
            Effect.orDie,
            Effect.map(
              (shell) => shell._tag === "Some" && shell.value.hasPendingApprovals === true,
            ),
          ),
        );
        const detail = yield* services.snapshot
          .getThreadDetailById(pair.builderThreadId)
          .pipe(Effect.orDie);
        const request =
          detail._tag === "Some"
            ? detail.value.activities.find((activity) => activity.kind === "approval.requested")
            : undefined;
        expect(request).toBeDefined();
        const answer = yield* connection.dispatch({
          type: "thread.approval.respond",
          threadId: pair.builderThreadId,
          requestId: "req-helix-1",
          ...(typeof (request?.payload as { lifecycleGeneration?: string } | undefined)
            ?.lifecycleGeneration === "string"
            ? {
                lifecycleGeneration: (request!.payload as { lifecycleGeneration: string })
                  .lifecycleGeneration,
              }
            : {}),
          decision: "accept",
        });
        expect(answer.errorMessage).toBeUndefined();
        yield* waitUntil("builder approved", () => approved);
        expect(provider.approvals[0]).toMatchObject({
          threadId: pair.builderThreadId,
          decision: "accept",
        });
      }),
    );
  }, 120_000);

  it("holds the pair after a restart mid-handoff, re-applies roles first, and re-dispatches nothing", async () => {
    const world = makeWorld({ enableHelix: true });
    const provider = world.provider;
    let builderThreadId = "";
    await runScoped(
      Effect.gen(function* () {
        const { connection, services } = yield* connect(world);
        yield* seedLead(world, connection);
        yield* enableHelix(connection);
        const pair = yield* pairOf(services);
        builderThreadId = pair.builderThreadId;
        provider.script(LEAD, (ctx) =>
          Effect.gen(function* () {
            yield* ctx.callTool("helix_delegate", { requestId: "r", brief: BRIEF, waitSeconds: 0 });
            yield* ctx.complete();
          }),
        );
        provider.script(pair.builderThreadId, () => Effect.never);
        yield* userTurn(connection, LEAD, "start");
        // Mid-handoff: the Builder's turn has started and is bound to the handoff.
        yield* waitUntil("handoff running", () =>
          latestHandoff(services).pipe(
            Effect.map((handoff) => handoff?.state === "running" && handoff.builderTurnId !== null),
          ),
        );
      }),
    );
    const sendsBefore = provider.sends.length;
    const startsBefore = provider.starts.length;
    await runScoped(
      Effect.gen(function* () {
        // The rebuilt server, over the same database.
        const { connection, services } = yield* connect(world);
        // Roles are applied while the layers build, before any MCP request.
        expect(services.credentials.getThreadRoleProfile?.(builderThreadId)?.kind).toBe(
          "helix_builder",
        );
        expect(services.credentials.getThreadRoleProfile?.(LEAD)?.kind).toBe("helix_lead");
        const credential = services.credentials.connectionForThread(
          ThreadId.makeUnsafe(builderThreadId),
          "codex",
        );
        expect([
          ...(services.credentials.verifySession(credential.bearerToken)?.capabilities ?? []),
        ]).toEqual(["helix:builder"]);
        const pair = yield* pairOf(services);
        expect(pair.hold?.kind).toBe("restart");
        expect(pair.hold?.reason).toContain("restarted");
        // The turn's fate is unknown: it is not closed or resent, only held.
        const handoff = yield* latestHandoff(services);
        expect(handoff.state).toBe("running");
        expect(handoff.delivery).toBe("none");
        expect(handoff.dispatchAttempts).toBe(1);
        yield* Effect.sleep(Duration.millis(500));
        expect(provider.sends.length).toBe(sendsBefore);
        expect(provider.starts.length).toBe(startsBefore);

        // Resume releases the hold but resends nothing: the orphaned turn is not replayed.
        const resumed = yield* connection.call(HELIX_WS_METHODS.resume, {
          pairId: pair.id,
          expectedRevision: (yield* pairOf(services)).revision,
        });
        expect(resumed.errorMessage).toBeUndefined();
        expect((yield* pairOf(services)).hold).toBeNull();
        // The engine's restart reconciliation ends the orphaned turn; Helix settled
        // it under the hold and, now released, delivers that result once. Nothing
        // is resent to the Builder.
        yield* waitUntil("orphaned turn settled and delivered", () =>
          latestHandoff(services).pipe(
            Effect.map((handoff) => handoff.state !== "running" && handoff.delivery !== "pending"),
          ),
        );
        const settled = yield* latestHandoff(services);
        expect(settled.state).toBe("interrupted");
        expect(provider.sendsTo(builderThreadId)).toHaveLength(1);
        yield* waitUntil(
          "one wake",
          () =>
            provider.sendsTo(LEAD).filter((send) => send.input.includes("Helix: Builder result"))
              .length === 1,
        );
        yield* Effect.sleep(Duration.millis(300));
        expect(
          provider.sendsTo(LEAD).filter((send) => send.input.includes("Helix: Builder result")),
        ).toHaveLength(1);

        // Stop leaves no handoff in the slot.
        const stopped = yield* connection.call(HELIX_WS_METHODS.stop, { pairId: pair.id });
        expect(stopped.errorMessage).toBeUndefined();
        const handoffs = yield* services.helix.listHandoffs(pair.id).pipe(Effect.orDie);
        expect(
          handoffs.some((entry) => ["prepared", "dispatching", "running"].includes(entry.state)),
        ).toBe(false);

        // The user speaks again; the Lead can delegate the next piece of work.
        provider.script(LEAD, (ctx) =>
          Effect.gen(function* () {
            yield* ctx.callTool("helix_delegate", {
              requestId: "after-restart",
              brief: BRIEF,
              waitSeconds: 0,
            });
            yield* ctx.complete();
          }),
        );
        yield* userTurn(connection, LEAD, "carry on");
        yield* waitUntil("new brief sent", () => provider.sendsTo(builderThreadId).length === 1);
      }),
    );
  }, 120_000);

  it("a provider-initiated recovery after disable starts the former Lead with no role", async () => {
    const world = makeWorld({ enableHelix: true });
    const provider = world.provider;
    await runScoped(
      Effect.gen(function* () {
        const { connection, services } = yield* connect(world);
        yield* seedLead(world, connection);
        const enabled = yield* enableHelix(connection);
        expect(enabled.errorMessage).toBeUndefined();
        yield* userTurn(connection, LEAD, "start");
        yield* waitUntil("lead turn done", () =>
          services.snapshot.getThreadShellById(ThreadId.makeUnsafe(LEAD)).pipe(
            Effect.orDie,
            Effect.map(
              (shell) =>
                shell._tag === "Some" &&
                shell.value.latestTurn?.state === "completed" &&
                provider.sendsTo(LEAD).length === 1,
            ),
          ),
        );
        expect(provider.startsFor(LEAD).at(-1)!.input.helixRole?.role).toBe("lead");

        const pair = yield* pairOf(services);
        const disabled = yield* connection.call(HELIX_WS_METHODS.disable, {
          pairId: pair.id,
          expectedRevision: pair.revision,
        });
        expect(disabled.errorMessage).toBeUndefined();
        expect((yield* pairOf(services)).lifecycle).toBe("disabled");

        // The provider process dies; ProviderService recovers on the next send,
        // outside the provider command reactor, from the persisted binding.
        const startsBefore = provider.startsFor(LEAD).length;
        for (const drop of provider.sessionDroppers) drop(LEAD);
        yield* services.providerService
          .sendTurn({ threadId: ThreadId.makeUnsafe(LEAD), input: "after disable" })
          .pipe(Effect.orDie);
        const recovered = provider.startsFor(LEAD);
        expect(recovered.length).toBe(startsBefore + 1);
        // The persisted binding said "lead"; the registered resolver says "no longer".
        expect(recovered.at(-1)!.input).not.toHaveProperty("helixRole");
        expect(recovered.at(-1)!.input.resumeCursor).toBeDefined();
      }),
    );
  }, 120_000);

  it("with Helix off, or next to an active pair, an ordinary thread behaves exactly the same", async () => {
    const trace = async (enableHelixSetting: boolean, neighbourPair = false) => {
      const world = makeWorld({ enableHelix: enableHelixSetting });
      const provider = world.provider;
      const eventTypes: string[] = [];
      await runScoped(
        Effect.gen(function* () {
          const { connection, services } = yield* connect(world);
          yield* seedLead(world, connection);
          if (!enableHelixSetting) {
            const refused = yield* enableHelix(connection);
            expect(refused.errorCode).toBe("HELIX_DISABLED");
          }
          if (neighbourPair) {
            // Another chat in the same project is an active Lead.
            const created = yield* connection.dispatch({
              type: "thread.create",
              threadId: NEIGHBOUR,
              projectId: PROJECT,
              title: "Neighbour Lead",
              modelSelection: { provider: "claudeAgent", model: "sonnet" },
              runtimeMode: "approval-required",
              interactionMode: "default",
              envMode: "worktree",
              branch: "feature/helix",
              worktreePath: world.worktreeDir,
            });
            expect(created.errorMessage).toBeUndefined();
            yield* waitUntil("neighbour projected", () =>
              services.snapshot.getThreadShellById(ThreadId.makeUnsafe(NEIGHBOUR)).pipe(
                Effect.orDie,
                Effect.map((shell) => shell._tag === "Some"),
              ),
            );
            const enabled = yield* connection.call(HELIX_WS_METHODS.enable, {
              leadThreadId: NEIGHBOUR,
              builderModelSelection: { provider: "codex", model: "gpt-5" },
            });
            expect(enabled.errorMessage).toBeUndefined();
          }
          provider.script(LEAD, (ctx) =>
            Effect.gen(function* () {
              yield* ctx.say("Working.");
              yield* Effect.never;
            }),
          );
          yield* userTurn(connection, LEAD, "do something");
          yield* waitUntil("turn sent", () => provider.sendsTo(LEAD).length === 1);
          // Deterministic trace: the streamed text is projected before the Stop.
          yield* waitUntil("assistant text projected", () =>
            services.snapshot.getThreadDetailById(ThreadId.makeUnsafe(LEAD)).pipe(
              Effect.orDie,
              Effect.map(
                (detail) =>
                  detail._tag === "Some" &&
                  detail.value.messages.some(
                    (message) => message.role === "assistant" && message.text === "Working.",
                  ),
              ),
            ),
          );
          yield* connection.dispatch({ type: "thread.turn.interrupt", threadId: LEAD });
          yield* waitUntil("interrupted", () => provider.interrupts.length === 1);
          yield* userTurn(connection, LEAD, "again");
          yield* waitUntil("second turn", () => provider.sendsTo(LEAD).length === 2);
          const toolNames = yield* listTools(world, LEAD);
          expect(toolNames.some((name) => name.startsWith("helix_"))).toBe(false);
          const detail = yield* services.snapshot
            .getThreadDetailById(ThreadId.makeUnsafe(LEAD))
            .pipe(Effect.orDie);
          if (detail._tag === "Some") {
            eventTypes.push(
              ...detail.value.messages.map((message) => `${message.role}:${message.text}`),
            );
          }
          expect(yield* services.helix.listPairs().pipe(Effect.orDie)).toHaveLength(
            neighbourPair ? 1 : 0,
          );
        }),
      );
      return {
        starts: provider.starts.map((start) => ({
          provider: start.provider,
          keys: Object.keys(start.input).toSorted(),
          helixRole: start.input.helixRole ?? null,
          autoApprove: start.input.autoApproveSynaraTools ?? null,
        })),
        sends: provider.sends.map((send) => send.input),
        interrupts: provider.interrupts.length,
        messages: eventTypes,
      };
    };
    const off = await trace(false);
    const on = await trace(true);
    const besidePair = await trace(true, true);
    expect(off).toEqual(on);
    expect(besidePair).toEqual(on);
    expect(off.starts.every((start) => start.helixRole === null)).toBe(true);
  }, 120_000);
});
