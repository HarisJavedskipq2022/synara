/**
 * ProviderHelixRoleResolver - lets ProviderService ask Helix for a thread's
 * current role when it restarts a session on its own (session recovery,
 * proactive credential rotation, provider-switch restore) instead of through
 * the provider command reactor.
 *
 * A late-bound registry, so the provider layer does not depend on the Helix
 * coordinator (which is built after it): Helix registers its lookup once it
 * exists; until then `resolve` answers `undefined` ("no resolver").
 *
 * @module provider/Services/ProviderHelixRoleResolver
 */
import type { ProviderHelixRoleContext, ThreadId } from "@synara/contracts";
import { Effect, Layer, ServiceMap } from "effect";

export type ProviderHelixRoleLookup = (
  threadId: ThreadId,
) => Effect.Effect<ProviderHelixRoleContext | null>;

export interface ProviderHelixRoleResolverShape {
  /**
   * The thread's current role: the context to start with, `null` when the
   * thread is not (or no longer) a participant, `undefined` when no lookup is
   * registered.
   */
  readonly resolve: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderHelixRoleContext | null | undefined>;
  /** Install the lookup; the latest registration wins. */
  readonly register: (lookup: ProviderHelixRoleLookup) => Effect.Effect<void>;
}

export class ProviderHelixRoleResolver extends ServiceMap.Service<
  ProviderHelixRoleResolver,
  ProviderHelixRoleResolverShape
>()("synara/provider/Services/ProviderHelixRoleResolver") {}

export const makeProviderHelixRoleResolver = (): ProviderHelixRoleResolverShape => {
  let lookup: ProviderHelixRoleLookup | undefined;
  return {
    resolve: (threadId) => (lookup === undefined ? Effect.succeed(undefined) : lookup(threadId)),
    register: (next) =>
      Effect.sync(() => {
        lookup = next;
      }),
  };
};

export const ProviderHelixRoleResolverLive = Layer.sync(
  ProviderHelixRoleResolver,
  makeProviderHelixRoleResolver,
);
