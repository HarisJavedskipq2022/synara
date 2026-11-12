import type { HelixPairSummary, HelixPairView, ThreadId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The record from the field: an active pair created by the earlier build (setup dialog),
// held by Stop, whose Builder was never created and which has no handoffs.
const LEAD = "lead-field" as ThreadId;
const fieldSummary = {
  pairId: "helix-pair:field",
  projectId: "project-1",
  leadThreadId: LEAD,
  builderThreadId: "builder-field",
  lifecycle: "active",
  status: "stopped",
  hold: {
    kind: "stop",
    reason: "Stopped by the user.",
    limit: null,
    handoffId: null,
    epoch: 1,
    since: "2026-11-12T12:02:58.504Z",
  },
  activeHandoffId: null,
  revision: 1,
  updatedAt: "2026-11-12T12:02:58.504Z",
} as unknown as HelixPairSummary;
const fieldView = {
  summary: fieldSummary,
  pair: {
    id: "helix-pair:field",
    projectId: "project-1",
    leadThreadId: LEAD,
    builderThreadId: "builder-field",
    builderCreatedAt: null,
    lifecycle: "active",
    revision: 1,
    cancellationEpoch: 1,
    hold: fieldSummary.hold,
    goal: { seq: 1, sourceMessageId: null, startedAt: null, dispatchCount: 0, dispatchBudget: 20 },
    config: {
      builderModelSelection: {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: { effort: "high" },
        supportsAutoMode: true,
      },
      builderRuntimeMode: "full-access",
      limits: { maxCorrectionsPerWorkItem: 3, maxDispatchesPerGoal: 20 },
      rolePromptVersions: { lead: "helix-roles/2", builder: "helix-roles/2" },
    },
    createdAt: "2026-11-12T12:00:00.000Z",
    updatedAt: "2026-11-12T12:02:58.504Z",
  },
  handoffs: [],
} as unknown as HelixPairView;

let supported = false;
const capabilityListeners = new Set<() => void>();
const helixApi = {
  listPairs: vi.fn(async () => ({ pairs: [fieldSummary], quarantined: [] })),
  getPair: vi.fn(async () => fieldView),
  subscribe: vi.fn(async () => undefined),
  unsubscribe: vi.fn(async () => undefined),
  onEvent: vi.fn(() => () => undefined),
};

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({ helix: helixApi }),
  readNativeApiServerCapability: () => supported,
  onNativeApiServerCapabilitiesChange: (
    listener: () => void,
    options?: { readonly replayCurrent?: boolean },
  ) => {
    capabilityListeners.add(listener);
    if (options?.replayCurrent) listener();
    return () => capabilityListeners.delete(listener);
  },
}));

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

describe("Lead view at launch", () => {
  beforeEach(() => {
    supported = false;
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.resetModules();
  });

  it("loads the view of a Lead that mounted before the server offered Helix", async () => {
    const { retainHelixLeadDetail } = await import("./helixSync");
    const { useHelixStore } = await import("./helixStore");
    const { resolveComposerHelixControl } =
      await import("~/components/chat/helix/composerHelixControl.logic");

    // The composer and capsule mount first: nothing may be asked of the server yet.
    const releaseCapsule = retainHelixLeadDetail(LEAD);
    const releaseControl = retainHelixLeadDetail(LEAD);
    await flush();
    expect(helixApi.getPair).not.toHaveBeenCalled();
    expect(helixApi.subscribe).not.toHaveBeenCalled();

    // Negotiation finishes: the pair list and the retained Lead's view and stream load.
    supported = true;
    for (const listener of capabilityListeners) listener();
    await flush();
    expect(helixApi.getPair).toHaveBeenCalledExactlyOnceWith({ leadThreadId: LEAD });
    expect(helixApi.subscribe).toHaveBeenCalledWith({ leadThreadId: LEAD });

    const state = useHelixStore.getState();
    const detail = state.detailByLeadThreadId.get(LEAD);
    expect(detail?.status).toBe("ready");
    expect(detail?.view?.pair.config.builderModelSelection).toMatchObject({
      provider: "claudeAgent",
      model: "claude-opus-5-5",
    });
    // The held pair's control names its Claude Builder.
    expect(
      resolveComposerHelixControl({
        settingOn: true,
        summary: state.summaryByLeadThreadId.get(LEAD) ?? null,
        view: detail?.view ?? null,
        choice: undefined,
      }).label,
    ).toBe("Helix · Claude Opus 5.5");

    releaseControl();
    expect(helixApi.unsubscribe).not.toHaveBeenCalled();
    releaseCapsule();
    // The last consumer leaves: this Lead's stream ends (and the pair sync with it).
    expect(helixApi.unsubscribe).toHaveBeenCalledWith({ leadThreadId: LEAD });
  });

  it("asks at once when Helix is already known to be offered", async () => {
    supported = true;
    const { retainHelixLeadDetail } = await import("./helixSync");
    const release = retainHelixLeadDetail(LEAD);
    await flush();
    expect(helixApi.getPair).toHaveBeenCalledExactlyOnceWith({ leadThreadId: LEAD });
    expect(helixApi.subscribe).toHaveBeenCalledTimes(2); // pairs ({}) and this Lead
    release();
  });
});
