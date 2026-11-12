// FILE: helixStore.ts
// Purpose: Client state for Helix pairs: every pair's summary (so Builders stay hidden
//          and Lead rows can show the pair status) and, for Lead chats that are open,
//          the full pair view with its handoffs. Fed by helix.listPairs / getPair and
//          the helix.subscribe stream; every write keeps the higher revision.
// Layer: Web Helix data (zustand)
// Exports: useHelixStore, reducers and narrow selectors

import type {
  HelixCapabilitiesResult,
  HelixHandoff,
  HelixQuarantinedPair,
  HelixPairSummary,
  HelixPairView,
  HelixStreamEvent,
  ThreadId,
} from "@synara/contracts";
import { create } from "zustand";

import type { HelixErrorKind } from "./helixErrors";
import { sortHelixHandoffs, upsertHelixHandoff } from "./helixPresentation";

export interface HelixLeadDetail {
  readonly status: "loading" | "ready" | "error";
  /** Null once loaded means the Lead has no pair. */
  readonly view: HelixPairView | null;
  readonly error: HelixErrorKind | null;
}

export interface HelixStoreState {
  /** The connected server advertises `helix.pairs`. */
  readonly supported: boolean;
  /** The server also advertises `helix.message-pairing`: messages may carry a Helix choice. */
  readonly messagePairingSupported: boolean;
  readonly pairsStatus: "idle" | "loading" | "ready" | "error";
  readonly pairsError: HelixErrorKind | null;
  readonly summaryByLeadThreadId: ReadonlyMap<string, HelixPairSummary>;
  /** Builder thread id → its Lead thread id, for every pair (active and disabled). */
  readonly leadByBuilderThreadId: ReadonlyMap<string, ThreadId>;
  readonly detailByLeadThreadId: ReadonlyMap<string, HelixLeadDetail>;
  /** Pairs whose stored data the server could not read, by Lead thread. Only Remove helps. */
  readonly quarantinedByLeadThreadId: ReadonlyMap<string, HelixQuarantinedPair>;
  readonly capabilities: HelixCapabilitiesResult | null;
  readonly capabilitiesError: HelixErrorKind | null;
}

export const INITIAL_HELIX_STATE: HelixStoreState = {
  supported: false,
  messagePairingSupported: false,
  pairsStatus: "idle",
  pairsError: null,
  summaryByLeadThreadId: new Map(),
  leadByBuilderThreadId: new Map(),
  detailByLeadThreadId: new Map(),
  quarantinedByLeadThreadId: new Map(),
  capabilities: null,
  capabilitiesError: null,
};

export const useHelixStore = create<HelixStoreState>(() => INITIAL_HELIX_STATE);

// ── Pure reducers (exported for tests) ─────────────────────────────────

function withBuilderIndex(
  state: HelixStoreState,
  summaries: ReadonlyMap<string, HelixPairSummary>,
  quarantined: ReadonlyMap<string, HelixQuarantinedPair> = state.quarantinedByLeadThreadId,
): Pick<
  HelixStoreState,
  "summaryByLeadThreadId" | "leadByBuilderThreadId" | "quarantinedByLeadThreadId"
> {
  const leadByBuilderThreadId = new Map<string, ThreadId>();
  // A quarantined pair's Builder stays hidden and restricted until the pair is removed.
  for (const entry of quarantined.values()) {
    leadByBuilderThreadId.set(entry.builderThreadId, entry.leadThreadId as ThreadId);
  }
  for (const summary of summaries.values()) {
    leadByBuilderThreadId.set(summary.builderThreadId, summary.leadThreadId);
  }
  // Keep the old map identity when nothing moved, so the hidden-id set stays stable.
  const unchanged =
    leadByBuilderThreadId.size === state.leadByBuilderThreadId.size &&
    [...leadByBuilderThreadId].every(
      ([builder, lead]) => state.leadByBuilderThreadId.get(builder) === lead,
    );
  return {
    summaryByLeadThreadId: summaries,
    leadByBuilderThreadId: unchanged ? state.leadByBuilderThreadId : leadByBuilderThreadId,
    quarantinedByLeadThreadId: quarantined,
  };
}

function quarantineMap(
  entries: readonly HelixQuarantinedPair[] | undefined,
  current: ReadonlyMap<string, HelixQuarantinedPair>,
): ReadonlyMap<string, HelixQuarantinedPair> {
  // Older servers send no list: keep what is known.
  if (entries === undefined) return current;
  return new Map(entries.map((entry) => [entry.leadThreadId, entry] as const));
}

function isNewer(next: HelixPairSummary, current: HelixPairSummary | undefined): boolean {
  return current === undefined || next.revision >= current.revision;
}

/** A complete list (helix.listPairs) is authoritative, except for rows that moved on since. */
export function reduceHelixPairList(
  state: HelixStoreState,
  pairs: readonly HelixPairSummary[],
  quarantined?: readonly HelixQuarantinedPair[],
): HelixStoreState {
  const next = new Map<string, HelixPairSummary>();
  for (const summary of pairs) {
    const current = state.summaryByLeadThreadId.get(summary.leadThreadId);
    next.set(
      summary.leadThreadId,
      current && current.revision > summary.revision ? current : summary,
    );
  }
  return {
    ...state,
    ...withBuilderIndex(state, next, quarantineMap(quarantined, state.quarantinedByLeadThreadId)),
    pairsStatus: "ready",
    pairsError: null,
  };
}

function reduceSummary(state: HelixStoreState, summary: HelixPairSummary): HelixStoreState {
  const current = state.summaryByLeadThreadId.get(summary.leadThreadId);
  if (!isNewer(summary, current)) return state;
  const summaries = new Map(state.summaryByLeadThreadId);
  summaries.set(summary.leadThreadId, summary);
  const detail = state.detailByLeadThreadId.get(summary.leadThreadId);
  let details = state.detailByLeadThreadId;
  if (detail?.view && summary.revision >= detail.view.summary.revision) {
    const next = new Map(details);
    next.set(summary.leadThreadId, { ...detail, view: { ...detail.view, summary } });
    details = next;
  }
  return { ...state, ...withBuilderIndex(state, summaries), detailByLeadThreadId: details };
}

/** A full view from getPair or a mutation. Older views never replace newer ones. */
export function reduceHelixView(
  state: HelixStoreState,
  leadThreadId: string,
  view: HelixPairView | null,
): HelixStoreState {
  const current = state.detailByLeadThreadId.get(leadThreadId);
  if (view && current?.view && current.view.pair.revision > view.pair.revision) {
    return current.status === "ready" ? state : setDetail(state, leadThreadId, current.view);
  }
  const normalized = view ? { ...view, handoffs: sortHelixHandoffs(view.handoffs) } : null;
  const withDetail = setDetail(state, leadThreadId, normalized);
  return normalized ? reduceSummary(withDetail, normalized.summary) : withDetail;
}

function setDetail(
  state: HelixStoreState,
  leadThreadId: string,
  view: HelixPairView | null,
): HelixStoreState {
  const details = new Map(state.detailByLeadThreadId);
  details.set(leadThreadId, { status: "ready", view, error: null });
  return { ...state, detailByLeadThreadId: details };
}

function reduceHandoff(state: HelixStoreState, handoff: HelixHandoff): HelixStoreState {
  for (const [leadThreadId, detail] of state.detailByLeadThreadId) {
    if (!detail.view || detail.view.pair.id !== handoff.pairId) continue;
    const handoffs = upsertHelixHandoff(detail.view.handoffs, handoff);
    if (handoffs === detail.view.handoffs) return state;
    const details = new Map(state.detailByLeadThreadId);
    details.set(leadThreadId, { ...detail, view: { ...detail.view, handoffs } });
    return { ...state, detailByLeadThreadId: details };
  }
  return state;
}

export function reduceRemoved(state: HelixStoreState, leadThreadId: string): HelixStoreState {
  if (
    !state.summaryByLeadThreadId.has(leadThreadId) &&
    !state.detailByLeadThreadId.has(leadThreadId) &&
    !state.quarantinedByLeadThreadId.has(leadThreadId)
  ) {
    return state;
  }
  const quarantined = new Map(state.quarantinedByLeadThreadId);
  quarantined.delete(leadThreadId);
  const summaries = new Map(state.summaryByLeadThreadId);
  summaries.delete(leadThreadId);
  const details = new Map(state.detailByLeadThreadId);
  if (details.has(leadThreadId)) {
    details.set(leadThreadId, { status: "ready", view: null, error: null });
  }
  return {
    ...state,
    ...withBuilderIndex(state, summaries, quarantined),
    detailByLeadThreadId: details,
  };
}

export function reduceHelixEvent(state: HelixStoreState, event: HelixStreamEvent): HelixStoreState {
  switch (event.type) {
    case "snapshot": {
      // Every subscription starts with one; merge rather than replace, since a scoped
      // snapshot can trail a pair event that arrived on another subscription.
      let next = state;
      if (event.quarantined !== undefined) {
        next = {
          ...next,
          ...withBuilderIndex(
            next,
            next.summaryByLeadThreadId,
            quarantineMap(event.quarantined, next.quarantinedByLeadThreadId),
          ),
        };
      }
      for (const summary of event.pairs) next = reduceSummary(next, summary);
      next = { ...next, pairsStatus: "ready", pairsError: null };
      return event.view ? reduceHelixView(next, event.view.summary.leadThreadId, event.view) : next;
    }
    case "pair-upserted":
      return reduceSummary(state, event.summary);
    case "handoff-upserted":
      return reduceHandoff(state, event.handoff);
    case "pair-removed":
      return reduceRemoved(state, event.leadThreadId);
  }
}

export function reduceHelixDetailStatus(
  state: HelixStoreState,
  leadThreadId: string,
  status: "loading" | "error",
  error: HelixErrorKind | null,
): HelixStoreState {
  const current = state.detailByLeadThreadId.get(leadThreadId);
  const details = new Map(state.detailByLeadThreadId);
  details.set(leadThreadId, { status, view: current?.view ?? null, error });
  return { ...state, detailByLeadThreadId: details };
}

// ── Selectors ──────────────────────────────────────────────────────────

const EMPTY_IDS: ReadonlySet<string> = new Set();
const builderIdSetCache = new WeakMap<ReadonlyMap<string, ThreadId>, ReadonlySet<string>>();

/** Builder thread ids to keep out of thread lists. Stable while the pairs do not change. */
export function selectHelixBuilderThreadIds(state: HelixStoreState): ReadonlySet<string> {
  const map = state.leadByBuilderThreadId;
  if (map.size === 0) return EMPTY_IDS;
  const cached = builderIdSetCache.get(map);
  if (cached) return cached;
  const ids = new Set(map.keys());
  builderIdSetCache.set(map, ids);
  return ids;
}
