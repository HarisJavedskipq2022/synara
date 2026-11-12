/**
 * Live Helix coordinator: wires the coordinator to the engine, projections,
 * settings and gateway credentials, runs startup reconciliation while the
 * layer is built (before the gateway serves MCP), and feeds it every domain
 * event plus a periodic sweep for output that settles after its last event.
 *
 * Provides `HelixService` (helix.* RPCs), `HelixGatewayPort` (helix_* tools)
 * and `HelixCoordinatorService` (hooks for the reactor, wsRpc and gateway).
 *
 * @module helix/Layers/HelixCoordinator
 */
import type { OrchestrationEvent } from "@synara/contracts";
import { Duration, Effect, Layer, Option, Queue, Schedule, Stream } from "effect";

import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventDeliveryRepository } from "../../persistence/Services/OrchestrationEventDeliveries.ts";
import { HelixRepository } from "../../persistence/Services/HelixRepository.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectAgentService } from "../../projectAgent/Services/ProjectAgentService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeHelixCoordinator } from "../coordinator.ts";
import { makeLiveHelixRuntime } from "../runtime.ts";
import { ProviderHelixRoleResolver } from "../../provider/Services/ProviderHelixRoleResolver.ts";
import { HelixCoordinatorCore, HelixCoordinatorService } from "../Services/HelixCoordinator.ts";
import { HelixGatewayPort } from "../Services/HelixGatewayPort.ts";
import { HelixService } from "../Services/HelixService.ts";

/** Output can settle after the Builder's last domain event; this catches it. */
const HELIX_SWEEP_INTERVAL = Duration.seconds(2);

const makeCore = Effect.gen(function* () {
  const repository = yield* HelixRepository;
  const settings = yield* ServerSettingsService;
  const engine = yield* OrchestrationEngineService;
  const credentials = Option.getOrUndefined(yield* Effect.serviceOption(AgentGatewayCredentials));
  const projectAgent = Option.getOrUndefined(yield* Effect.serviceOption(ProjectAgentService));
  const runtime = yield* makeLiveHelixRuntime({
    engine,
    snapshotQuery: yield* ProjectionSnapshotQuery,
    projectionTurns: yield* ProjectionTurnRepository,
    receipts: yield* OrchestrationCommandReceiptRepository,
    deliveries: yield* OrchestrationEventDeliveryRepository,
  });
  if (credentials?.setThreadRoleProfile === undefined) {
    // The coordinator then refuses to enable any pair: it could not restrict a Builder.
    yield* Effect.logError("helix: gateway role profiles unavailable; Helix cannot be enabled");
  }
  const coordinator = yield* makeHelixCoordinator({
    repository,
    runtime,
    isEnabled: settings.getSettings.pipe(
      Effect.map((current) => current.enableHelix),
      Effect.catch(() => Effect.succeed(false)),
    ),
    ...(credentials?.setThreadRoleProfile
      ? { setRoleProfile: credentials.setThreadRoleProfile }
      : {}),
    ...(projectAgent
      ? {
          isHubThread: (threadId) =>
            projectAgent.resolvePrincipalForThread(threadId).pipe(
              Effect.map((principal) => principal.kind !== "unmanaged"),
              Effect.catch(() => Effect.succeed(true)),
            ),
        }
      : {}),
  });

  // Paused for the user; nothing is replayed.
  // ProviderService asks this when it restarts a session on its own (recovery,
  // credential rotation, provider-switch restore), so a stale role is never revived.
  const roleResolver = Option.getOrUndefined(
    yield* Effect.serviceOption(ProviderHelixRoleResolver),
  );
  if (roleResolver) yield* roleResolver.register(coordinator.hooks.sessionRoleFor);

  yield* coordinator.hooks.reconcileStartup();

  // Decouple from the engine's publication: handling an event may dispatch.
  const pending = yield* Queue.unbounded<OrchestrationEvent>();
  yield* Stream.runForEach(engine.streamDomainEvents, (event) => Queue.offer(pending, event)).pipe(
    Effect.forkScoped,
  );
  yield* Queue.take(pending).pipe(
    Effect.flatMap(coordinator.hooks.onDomainEvent),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* coordinator.hooks
    .sweep()
    .pipe(Effect.repeat(Schedule.spaced(HELIX_SWEEP_INTERVAL)), Effect.forkScoped);
  return coordinator;
});

const HelixCoordinatorCoreLive = Layer.effect(HelixCoordinatorCore, makeCore);

export const HelixCoordinatorLive = Layer.mergeAll(
  Layer.effect(
    HelixService,
    Effect.gen(function* () {
      return (yield* HelixCoordinatorCore).service;
    }),
  ),
  Layer.effect(
    HelixGatewayPort,
    Effect.gen(function* () {
      return (yield* HelixCoordinatorCore).port;
    }),
  ),
  Layer.effect(
    HelixCoordinatorService,
    Effect.gen(function* () {
      return (yield* HelixCoordinatorCore).hooks;
    }),
  ),
).pipe(Layer.provideMerge(HelixCoordinatorCoreLive));
