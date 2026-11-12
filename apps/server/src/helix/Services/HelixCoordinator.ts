/**
 * HelixCoordinatorService - the hooks other subsystems call into Helix with:
 * the provider command reactor (session roles, automatic-turn gate, rename
 * guards), `wsRpc.ts` (client command interception), the gateway (Builder
 * targeting guard) and retention. Optional everywhere: absent means no Helix.
 *
 * @module helix/Services/HelixCoordinator
 */
import { ServiceMap } from "effect";

import type { HelixCoordinator, HelixCoordinatorHooks } from "../coordinator.ts";

export class HelixCoordinatorService extends ServiceMap.Service<
  HelixCoordinatorService,
  HelixCoordinatorHooks
>()("synara/helix/Services/HelixCoordinatorService") {}

/** The whole coordinator, from which the three public services are projected. */
export class HelixCoordinatorCore extends ServiceMap.Service<
  HelixCoordinatorCore,
  HelixCoordinator
>()("synara/helix/Services/HelixCoordinatorCore") {}
