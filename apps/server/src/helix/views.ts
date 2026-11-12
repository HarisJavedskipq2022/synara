/**
 * Pure projections from stored Helix rows to the wire views the RPCs, the
 * stream and the tools return. Shared so every surface reports the same
 * status for the same rows.
 *
 * @module helix/views
 */
import {
  HELIX_PAIR_VIEW_MAX_HANDOFFS,
  helixPairDisplayStatus,
  isHelixHandoffActive,
  type HelixHandoff,
  type HelixHandoffToolView,
  type HelixPair,
  type HelixPairSummary,
  type HelixPairView,
} from "@synara/contracts";

/** `handoffs` newest first, or any order containing the latest; only the latest matters. */
export function helixPairSummary(
  pair: HelixPair,
  handoffs: ReadonlyArray<HelixHandoff>,
): HelixPairSummary {
  const latest = handoffs.reduce<HelixHandoff | null>(
    (best, handoff) => (best === null || handoff.sequence > best.sequence ? handoff : best),
    null,
  );
  const active = handoffs.find((handoff) => isHelixHandoffActive(handoff.state)) ?? null;
  return {
    pairId: pair.id,
    projectId: pair.projectId,
    leadThreadId: pair.leadThreadId,
    builderThreadId: pair.builderThreadId,
    lifecycle: pair.lifecycle,
    status: helixPairDisplayStatus(pair, latest),
    hold: pair.hold,
    activeHandoffId: active?.id ?? null,
    latestHandoffState: latest?.state ?? null,
    latestHandoffFailure: latest?.failure?.reason ?? null,
    latestHandoffUpdatedAt: latest?.updatedAt ?? null,
    pendingChange: pair.config.pendingChange ?? null,
    revision: pair.revision,
    updatedAt: pair.updatedAt,
  };
}

export function helixPairView(
  pair: HelixPair,
  handoffs: ReadonlyArray<HelixHandoff>,
): HelixPairView {
  const newestFirst = handoffs.toSorted((a, b) => b.sequence - a.sequence);
  return {
    summary: helixPairSummary(pair, newestFirst),
    pair,
    handoffs: newestFirst.slice(0, HELIX_PAIR_VIEW_MAX_HANDOFFS),
  };
}

export function helixHandoffToolView(handoff: HelixHandoff): HelixHandoffToolView {
  return {
    handoffId: handoff.id,
    sequence: handoff.sequence,
    title: handoff.brief.title,
    state: handoff.state,
    delivery: handoff.delivery,
    correctionIndex: handoff.correctionIndex,
    workItemId: handoff.workItemId,
    result: handoff.result,
    review: handoff.review,
    failure: handoff.failure,
  };
}
