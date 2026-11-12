// FILE: helixSync.ts
// Purpose: Keep the Helix store current. One shared, ref-counted pair subscription
//          (helix.listPairs + helix.subscribe {}) runs while any surface needs pair
//          summaries; a Lead chat that is open adds a scoped subscription and its full
//          view (helix.getPair + helix.subscribe { leadThreadId }). Nothing runs on a
//          server without the `helix.pairs` capability.
// Layer: Web Helix data
// Exports: retainHelixPairsSync, retainHelixLeadDetail, refreshHelixLeadDetail,
//          loadHelixCapabilities, applyHelixView

import {
  WS_HELIX_MESSAGE_PAIRING_CAPABILITY,
  WS_HELIX_PAIRS_CAPABILITY,
  type HelixPairView,
  type HelixStreamEvent,
  type ThreadId,
} from "@synara/contracts";

import {
  onNativeApiServerCapabilitiesChange,
  readNativeApi,
  readNativeApiServerCapability,
} from "~/nativeApi";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useStore } from "~/store";
import {
  dropHelixDraftChoices,
  onHelixPairingSettled,
  staleHelixDraftChoices,
  useHelixDraftStore,
  type HelixActualPairing,
} from "./helixDraftStore";
import { classifyHelixError } from "./helixErrors";
import {
  INITIAL_HELIX_STATE,
  reduceHelixDetailStatus,
  reduceHelixEvent,
  reduceHelixPairList,
  reduceHelixView,
  useHelixStore,
} from "./helixStore";

function helixApi() {
  return readNativeApi()?.helix;
}

function isHelixSupported(): boolean {
  return readNativeApiServerCapability(WS_HELIX_PAIRS_CAPABILITY) && helixApi() !== undefined;
}

// ── Detail refetch, coalesced per Lead ────────────────────────────────

const DETAIL_REFETCH_DEBOUNCE_MS = 150;
const detailRefetchTimers = new Map<string, ReturnType<typeof setTimeout>>();
const detailLoads = new Map<string, Promise<void>>();

/** Reload one Lead's full view (after a stale revision or a newer pair revision). */
export function refreshHelixLeadDetail(leadThreadId: ThreadId): Promise<void> {
  const inFlight = detailLoads.get(leadThreadId);
  if (inFlight) return inFlight;
  const api = helixApi();
  if (!api) return Promise.resolve();
  const load = api
    .getPair({ leadThreadId })
    .then((view) => {
      useHelixStore.setState((state) => reduceHelixView(state, leadThreadId, view));
    })
    .catch((error: unknown) => {
      useHelixStore.setState((state) =>
        reduceHelixDetailStatus(state, leadThreadId, "error", classifyHelixError(error)),
      );
    })
    .finally(() => {
      detailLoads.delete(leadThreadId);
    });
  detailLoads.set(leadThreadId, load);
  return load;
}

function scheduleDetailRefetch(leadThreadId: ThreadId) {
  if (detailRefetchTimers.has(leadThreadId)) return;
  detailRefetchTimers.set(
    leadThreadId,
    setTimeout(() => {
      detailRefetchTimers.delete(leadThreadId);
      if (leadConsumers.has(leadThreadId)) void refreshHelixLeadDetail(leadThreadId);
    }, DETAIL_REFETCH_DEBOUNCE_MS),
  );
}

export function applyHelixView(leadThreadId: ThreadId, view: HelixPairView | null) {
  useHelixStore.setState((state) => reduceHelixView(state, leadThreadId, view));
}

function handleHelixEvent(event: HelixStreamEvent) {
  useHelixStore.setState((state) => reduceHelixEvent(state, event));
  if (event.type !== "pair-upserted") return;
  // A summary moves before the pair's goal and config reach the view; reload the view.
  const detail = useHelixStore.getState().detailByLeadThreadId.get(event.summary.leadThreadId);
  if (detail?.view && detail.view.pair.revision < event.summary.revision) {
    scheduleDetailRefetch(event.summary.leadThreadId);
  }
}

// ── Pair subscription ─────────────────────────────────────────────────

let pairsLoad: Promise<void> | null = null;

/** helix.listPairs, including pairs the server could not read. */
export function loadHelixPairs(): Promise<void> {
  if (pairsLoad) return pairsLoad;
  const api = helixApi();
  if (!api) return Promise.resolve();
  if (useHelixStore.getState().pairsStatus !== "ready") {
    useHelixStore.setState({ pairsStatus: "loading" });
  }
  pairsLoad = api
    .listPairs()
    .then((result) => {
      useHelixStore.setState((state) =>
        reduceHelixPairList(state, result.pairs, result.quarantined),
      );
    })
    .catch((error: unknown) => {
      useHelixStore.setState((state) =>
        state.pairsStatus === "ready"
          ? state
          : { ...state, pairsStatus: "error", pairsError: classifyHelixError(error) },
      );
    })
    .finally(() => {
      pairsLoad = null;
    });
  return pairsLoad;
}

let capabilitiesLoad: Promise<void> | null = null;

/** helix.capabilities: the setting's server value and per-provider role support. */
export function loadHelixCapabilities(): Promise<void> {
  if (capabilitiesLoad) return capabilitiesLoad;
  const api = helixApi();
  if (!api || !isHelixSupported()) return Promise.resolve();
  capabilitiesLoad = api
    .capabilities()
    .then((capabilities) => {
      useHelixStore.setState({ capabilities, capabilitiesError: null });
    })
    .catch((error: unknown) => {
      useHelixStore.setState({ capabilitiesError: classifyHelixError(error) });
    })
    .finally(() => {
      capabilitiesLoad = null;
    });
  return capabilitiesLoad;
}

function connectPairs(): () => void {
  const api = helixApi();
  if (!api) return () => undefined;
  const offEvent = api.onEvent(handleHelixEvent);
  void loadHelixPairs();
  void api.subscribe({}).catch(() => undefined);
  return () => {
    offEvent();
    void api.unsubscribe({}).catch(() => undefined);
  };
}

let pairsConsumers = 0;
let stopPairsSync: (() => void) | null = null;

function startPairsSync(): () => void {
  let disconnect: (() => void) | null = null;
  const evaluate = () => {
    const supported = isHelixSupported();
    const messagePairingSupported =
      supported && readNativeApiServerCapability(WS_HELIX_MESSAGE_PAIRING_CAPABILITY);
    if (useHelixStore.getState().messagePairingSupported !== messagePairingSupported) {
      useHelixStore.setState({ messagePairingSupported });
    }
    if (supported && disconnect === null) {
      useHelixStore.setState({ supported: true });
      disconnect = connectPairs();
      // Lead chats that mounted before the server said it offers Helix (at launch, the
      // composer mounts before negotiation finishes) load their view and events now.
      for (const leadThreadId of leadConsumers.keys()) connectLeadDetail(leadThreadId as ThreadId);
    } else if (!supported && disconnect !== null) {
      for (const leadThreadId of leadConsumers.keys())
        disconnectLeadDetail(leadThreadId as ThreadId);
      disconnect();
      disconnect = null;
      // Another server: none of the previous pairs apply.
      useHelixStore.setState(INITIAL_HELIX_STATE);
    } else if (!supported) {
      useHelixStore.setState({ supported: false });
    }
  };
  const unsubscribeCapabilities = onNativeApiServerCapabilitiesChange(evaluate, {
    replayCurrent: true,
  });
  return () => {
    unsubscribeCapabilities();
    disconnect?.();
    disconnect = null;
  };
}

/** Pair summaries stay live while at least one caller holds this. */
export function retainHelixPairsSync(): () => void {
  pairsConsumers += 1;
  if (pairsConsumers === 1) stopPairsSync = startPairsSync();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pairsConsumers -= 1;
    if (pairsConsumers === 0) {
      stopPairsSync?.();
      stopPairsSync = null;
    }
  };
}

// ── Lead detail subscription ──────────────────────────────────────────

const leadConsumers = new Map<string, number>();

/** The full view and handoff events for one Lead chat, while it is shown. */
export function retainHelixLeadDetail(leadThreadId: ThreadId): () => void {
  const releasePairs = retainHelixPairsSync();
  const count = (leadConsumers.get(leadThreadId) ?? 0) + 1;
  leadConsumers.set(leadThreadId, count);
  if (count === 1) {
    const current = useHelixStore.getState().detailByLeadThreadId.get(leadThreadId);
    if (!current?.view) {
      useHelixStore.setState((state) =>
        reduceHelixDetailStatus(state, leadThreadId, "loading", null),
      );
    }
    // Before the server has said it offers Helix, wait: the pairs sync connects every
    // retained Lead once it does. Asking now would fail and never be asked again.
    if (isHelixSupported()) connectLeadDetail(leadThreadId);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (leadConsumers.get(leadThreadId) ?? 1) - 1;
    if (remaining > 0) {
      leadConsumers.set(leadThreadId, remaining);
    } else {
      leadConsumers.delete(leadThreadId);
      disconnectLeadDetail(leadThreadId);
    }
    releasePairs();
  };
}

/** Lead views and scoped streams currently asked of the server. */
const connectedLeads = new Set<string>();

function connectLeadDetail(leadThreadId: ThreadId) {
  const api = helixApi();
  if (!api || connectedLeads.has(leadThreadId)) return;
  connectedLeads.add(leadThreadId);
  void api.subscribe({ leadThreadId }).catch(() => {
    // Not subscribed after all: the next connect (or reconnect) tries again.
    connectedLeads.delete(leadThreadId);
  });
  void refreshHelixLeadDetail(leadThreadId);
}

function disconnectLeadDetail(leadThreadId: ThreadId) {
  if (!connectedLeads.delete(leadThreadId)) return;
  void helixApi()
    ?.unsubscribe({ leadThreadId })
    .catch(() => undefined);
}

// A message turned Helix on, changed its Builder or turned it off: reload the pair list
// and the Lead's view before the composer lets go of the choice it showed.
onHelixPairingSettled(async (threadId) => {
  if (!isHelixSupported()) return;
  await Promise.allSettled([loadHelixPairs(), refreshHelixLeadDetail(threadId as ThreadId)]);
});

// ── Unsent choices that went stale ────────────────────────────────────

/** Drop stored composer choices that no longer mean anything (see staleHelixDraftChoices). */
export function pruneStaleHelixDraftChoices(now = Date.now()): void {
  const drafts = useHelixDraftStore.getState();
  if (drafts.choiceByThreadId.size === 0) return;
  const helix = useHelixStore.getState();
  const pairs = new Map<string, HelixActualPairing>();
  for (const summary of helix.summaryByLeadThreadId.values()) {
    const view = helix.detailByLeadThreadId.get(summary.leadThreadId)?.view ?? null;
    const sameView = view !== null && view.pair.id === summary.pairId ? view : null;
    pairs.set(summary.leadThreadId, {
      pairId: summary.pairId,
      active: summary.lifecycle === "active" && summary.status !== "disabled",
      builder: sameView?.pair.config.builderModelSelection ?? null,
      pendingChange:
        summary.pendingChange !== undefined
          ? summary.pendingChange
          : (sameView?.pair.config.pendingChange ?? null),
    });
  }
  const app = useStore.getState();
  const draftThreads = useComposerDraftStore.getState().draftThreadsByThreadId;
  const stale = staleHelixDraftChoices({
    choices: drafts.choiceByThreadId,
    meta: drafts.choiceMetaByThreadId,
    now,
    pairs,
    pairsKnown: helix.supported && helix.pairsStatus === "ready",
    chatExists: (threadId) =>
      app.threadsHydrated
        ? app.sidebarThreadSummaryById[threadId] !== undefined ||
          draftThreads[threadId as ThreadId] !== undefined
        : undefined,
  });
  dropHelixDraftChoices(stale);
}

useHelixStore.subscribe((state, previous) => {
  if (
    state.pairsStatus !== previous.pairsStatus ||
    state.summaryByLeadThreadId !== previous.summaryByLeadThreadId ||
    state.detailByLeadThreadId !== previous.detailByLeadThreadId
  ) {
    pruneStaleHelixDraftChoices();
  }
});
