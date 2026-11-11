/**
 * ProviderHealth - Provider readiness snapshot service.
 *
 * Owns provider health checks, cache-backed snapshots, and change streaming
 * for transport layers that need provider install/auth status.
 *
 * @module ProviderHealth
 */
import type {
  ServerProviderStatus,
  ServerProviderUpdateInput,
  ServerProviderUpdateResult,
  ServerProviderUpdateError,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect, Stream } from "effect";

export interface ProviderHealthShape {
  /**
   * Read the latest provider health statuses.
   */
  readonly getStatuses: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;

  /**
   * Force a foreground refresh of provider health snapshots. Used for explicit
   * user actions: every enabled provider is re-probed.
   */
  readonly refresh: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;

  /**
   * Refresh for automatic triggers (window focus, visibility, timers). It may
   * reuse a recent healthy probe and cached CLI version output; providers that
   * were not ready and authenticated are re-probed. Optional so lightweight
   * test doubles can omit it; callers fall back to `refresh`.
   */
  readonly refreshAutomatic?: Effect.Effect<ReadonlyArray<ServerProviderStatus>>;

  /**
   * Run the allowlisted update command for a provider and publish the
   * resulting provider snapshots.
   */
  readonly updateProvider: (
    input: ServerProviderUpdateInput,
  ) => Effect.Effect<ServerProviderUpdateResult, ServerProviderUpdateError>;

  /**
   * Stream of provider snapshot changes for config consumers.
   */
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProviderStatus>>;
}

export class ProviderHealth extends ServiceMap.Service<ProviderHealth, ProviderHealthShape>()(
  "synara/provider/Services/ProviderHealth",
) {}
