import type { HelixHandoff, HelixPairSummary, HelixPairView } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  classifyHelixError,
  helixCommandRefusalMessageKey,
  helixRefusalReasonMessageKey,
} from "./helixErrors";
import {
  INITIAL_HELIX_STATE,
  reduceHelixEvent,
  reduceHelixPairList,
  reduceHelixView,
  reduceRemoved,
  selectHelixBuilderThreadIds,
} from "./helixStore";

function summary(lead: string, revision: number, overrides: Partial<HelixPairSummary> = {}) {
  return {
    pairId: `helix-pair:${lead}`,
    projectId: "project-1",
    leadThreadId: lead,
    builderThreadId: `builder-of-${lead}`,
    lifecycle: "active",
    status: "idle",
    hold: null,
    activeHandoffId: null,
    revision,
    updatedAt: "2026-11-12T00:00:00.000Z",
    ...overrides,
  } as HelixPairSummary;
}

function view(lead: string, revision: number, handoffs: HelixHandoff[] = []): HelixPairView {
  return {
    summary: summary(lead, revision),
    pair: { id: `helix-pair:${lead}`, revision } as HelixPairView["pair"],
    handoffs,
  };
}

function handoff(lead: string, id: string, sequence: number, revision: number) {
  return {
    id,
    pairId: `helix-pair:${lead}`,
    sequence,
    revision,
    state: "running",
  } as unknown as HelixHandoff;
}

describe("Helix store reducers", () => {
  it("indexes Builders and keeps the hidden-id set stable when nothing moved", () => {
    const first = reduceHelixPairList(INITIAL_HELIX_STATE, [summary("a", 1), summary("b", 1)]);
    const ids = selectHelixBuilderThreadIds(first);
    expect([...ids].toSorted()).toEqual(["builder-of-a", "builder-of-b"]);
    const second = reduceHelixEvent(first, { type: "pair-upserted", summary: summary("a", 2) });
    expect(selectHelixBuilderThreadIds(second)).toBe(ids);
    expect(second.summaryByLeadThreadId.get("a")?.revision).toBe(2);
  });

  it("ignores an older summary and keeps a newer row through a stale list", () => {
    const state = reduceHelixEvent(INITIAL_HELIX_STATE, {
      type: "pair-upserted",
      summary: summary("a", 5, { status: "building" }),
    });
    const stale = reduceHelixEvent(state, { type: "pair-upserted", summary: summary("a", 4) });
    expect(stale).toBe(state);
    const listed = reduceHelixPairList(state, [summary("a", 3)]);
    expect(listed.summaryByLeadThreadId.get("a")?.status).toBe("building");
  });

  it("merges handoff events into the open Lead's view", () => {
    let state = reduceHelixView(
      INITIAL_HELIX_STATE,
      "a" as never,
      view("a", 2, [handoff("a", "h1", 1, 1)]),
    );
    state = reduceHelixEvent(state, {
      type: "handoff-upserted",
      handoff: handoff("a", "h2", 2, 0),
    });
    state = reduceHelixEvent(state, {
      type: "handoff-upserted",
      handoff: handoff("a", "h1", 1, 0),
    });
    const handoffs = state.detailByLeadThreadId.get("a")?.view?.handoffs ?? [];
    expect(handoffs.map((entry) => [entry.id, entry.revision])).toEqual([
      ["h2", 0],
      ["h1", 1],
    ]);
  });

  it("never replaces a newer view with an older one", () => {
    const newer = reduceHelixView(INITIAL_HELIX_STATE, "a" as never, view("a", 4));
    const older = reduceHelixView(newer, "a" as never, view("a", 3));
    expect(older.detailByLeadThreadId.get("a")?.view?.pair.revision).toBe(4);
  });

  it("removes a deleted pair and its Builder from the hidden set", () => {
    const state = reduceHelixPairList(INITIAL_HELIX_STATE, [summary("a", 1)]);
    const removed = reduceHelixEvent(state, {
      type: "pair-removed",
      pairId: "helix-pair:a" as never,
      leadThreadId: "a" as never,
      builderThreadId: "builder-of-a" as never,
    });
    expect(removed.summaryByLeadThreadId.size).toBe(0);
    expect(selectHelixBuilderThreadIds(removed).size).toBe(0);
  });

  it("applies a snapshot's view without dropping other pairs", () => {
    const state = reduceHelixPairList(INITIAL_HELIX_STATE, [summary("b", 1)]);
    const next = reduceHelixEvent(state, {
      type: "snapshot",
      pairs: [summary("a", 1)],
      view: view("a", 1),
    });
    expect([...next.summaryByLeadThreadId.keys()].toSorted()).toEqual(["a", "b"]);
    expect(next.detailByLeadThreadId.get("a")?.status).toBe("ready");
  });
});

describe("classifyHelixError", () => {
  it("maps server codes to calm kinds and anything else to unknown", () => {
    expect(classifyHelixError({ code: "HELIX_NOT_IMPLEMENTED", message: "x" })).toBe(
      "not_implemented",
    );
    expect(classifyHelixError({ code: "HELIX_DISABLED" })).toBe("disabled");
    expect(classifyHelixError({ code: "HELIX_STALE_REVISION" })).toBe("stale_revision");
    expect(classifyHelixError({ code: "HELIX_PAIR_BUSY" })).toBe("busy");
    expect(classifyHelixError(new Error("boom"))).toBe("unknown");
    expect(classifyHelixError(null)).toBe("unknown");
  });
});

describe("helixCommandRefusalMessageKey", () => {
  it("names the refused command for a Lead", () => {
    expect(helixCommandRefusalMessageKey({ type: "thread.checkpoint.revert" }, false)).toBe(
      "chat:helix_refusal_revert",
    );
    expect(
      helixCommandRefusalMessageKey({ type: "thread.handoff.create", sourceThreadId: "a" }, false),
    ).toBe("chat:helix_refusal_handoff");
    expect(helixCommandRefusalMessageKey({ type: "thread.meta.update", branch: "x" }, false)).toBe(
      "chat:helix_refusal_workspace",
    );
    expect(
      helixCommandRefusalMessageKey(
        { type: "thread.turn.start", modelSelection: { provider: "cursor" } },
        false,
      ),
    ).toBe("chat:helix_refusal_provider");
  });

  it("names the refused command for a Builder", () => {
    expect(helixCommandRefusalMessageKey({ type: "thread.turn.start" }, true)).toBe(
      "chat:helix_refusal_builderMessage",
    );
    expect(helixCommandRefusalMessageKey({ type: "thread.archive" }, true)).toBe(
      "chat:helix_refusal_builderArchive",
    );
    expect(
      helixCommandRefusalMessageKey({ type: "thread.meta.update", envMode: "local" }, true),
    ).toBe("chat:helix_refusal_builderWorkspace");
    expect(
      helixCommandRefusalMessageKey({ type: "thread.meta.update", modelSelection: {} }, true),
    ).toBe("chat:helix_refusal_builderModel");
    expect(helixCommandRefusalMessageKey({ type: "thread.checkpoint.revert" }, true)).toBe(
      "chat:helix_refusal_revert",
    );
  });
});

describe("quarantined pairs", () => {
  const quarantined = {
    pairId: "helix-pair:q",
    leadThreadId: "lead-q",
    builderThreadId: "builder-q",
    reason: "config_json does not decode",
  };

  it("lists them beside readable pairs and keeps their Builder hidden", () => {
    const state = reduceHelixPairList(INITIAL_HELIX_STATE, [summary("a", 1)], [quarantined]);
    expect([...state.summaryByLeadThreadId.keys()]).toEqual(["a"]);
    expect(state.quarantinedByLeadThreadId.get("lead-q")?.pairId).toBe("helix-pair:q");
    expect([...selectHelixBuilderThreadIds(state)].toSorted()).toEqual([
      "builder-of-a",
      "builder-q",
    ]);
  });

  it("keeps the known list when an older server sends none, and drops a removed pair", () => {
    const state = reduceHelixPairList(INITIAL_HELIX_STATE, [], [quarantined]);
    const older = reduceHelixPairList(state, [summary("a", 1)]);
    expect(older.quarantinedByLeadThreadId.has("lead-q")).toBe(true);
    const removed = reduceRemoved(older, "lead-q");
    expect(removed.quarantinedByLeadThreadId.size).toBe(0);
    expect(selectHelixBuilderThreadIds(removed).has("builder-q")).toBe(false);
  });

  it("takes the snapshot's list when it carries one", () => {
    const state = reduceHelixEvent(INITIAL_HELIX_STATE, {
      type: "snapshot",
      pairs: [],
      view: null,
      quarantined: [quarantined],
    });
    expect(state.quarantinedByLeadThreadId.has("lead-q")).toBe(true);
  });
});

describe("helixRefusalReasonMessageKey", () => {
  it("names who is working for a refused revert, and ignores reasons it does not know", () => {
    expect(helixRefusalReasonMessageKey("revert_builder_busy")).toBe(
      "chat:helix_refusal_revertBuilderBusy",
    );
    expect(helixRefusalReasonMessageKey("revert_lead_busy")).toBe(
      "chat:helix_refusal_revertLeadBusy",
    );
    expect(helixRefusalReasonMessageKey("builder_read_only")).toBe(
      "chat:helix_refusal_builderMessage",
    );
    expect(helixRefusalReasonMessageKey("something_new")).toBeNull();
  });
});
