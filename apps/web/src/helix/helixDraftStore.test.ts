import {
  HelixPairingNotAppliedReason,
  type HelixMessagePairing,
  type ModelSelection,
} from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HELIX_DRAFT_CHOICE_MAX_AGE_MS,
  HELIX_DRAFT_CHOICES_STORAGE_KEY,
  clearPendingHelixTurnOff,
  dropHelixDraftChoices,
  staleHelixDraftChoices,
  type HelixActualPairing,
  HELIX_LAST_BUILDER_STORAGE_KEY,
  attachHelixMessagePairing,
  clearHelixDraftChoice,
  defaultHelixBuilder,
  dismissHelixPairingNote,
  onHelixPairingSettled,
  readRememberedHelixBuilder,
  recordHelixPairingOutcome,
  rememberHelixBuilder,
  resolveHelixControlState,
  resolveHelixMessagePairing,
  setHelixDraftChoice,
  toContractHelixPairing,
  useHelixDraftStore,
} from "./helixDraftStore";
import { helixPairingNotAppliedMessageKey } from "./helixErrors";

const codex = { provider: "codex", instanceId: "codex", model: "gpt-5.5" } as ModelSelection;
const claude = {
  provider: "claudeAgent",
  instanceId: "claudeAgent",
  model: "claude-opus-5",
} as ModelSelection;
const on = (builder: ModelSelection): HelixMessagePairing => ({
  enabled: true,
  builderModelSelection: builder,
});

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

const stored = (threadId: string) => useHelixDraftStore.getState().choiceByThreadId.get(threadId)!;

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
  useHelixDraftStore.setState({
    choiceByThreadId: new Map(),
    choiceMetaByThreadId: new Map(),
    noteByThreadId: new Map(),
  });
});

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("resolveHelixMessagePairing", () => {
  it("sends a touched choice only to a server that advertises message pairing", () => {
    expect(resolveHelixMessagePairing({ choice: on(codex), capabilityAdvertised: true })).toEqual(
      on(codex),
    );
    expect(
      resolveHelixMessagePairing({ choice: on(codex), capabilityAdvertised: false }),
    ).toBeUndefined();
    expect(
      resolveHelixMessagePairing({ choice: undefined, capabilityAdvertised: true }),
    ).toBeUndefined();
  });
});

describe("attachHelixMessagePairing", () => {
  const turnStart = {
    type: "thread.turn.start",
    commandId: "c",
    threadId: "t-1",
    message: { messageId: "m", role: "user", text: "hi", attachments: [] },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-11-12T00:00:00.000Z",
  } as never;

  it("rides only on user messages of the chat that holds the choice", () => {
    setHelixDraftChoice("t-1", on(codex));
    expect(attachHelixMessagePairing(turnStart, true).command).toMatchObject({ helix: on(codex) });
    expect(attachHelixMessagePairing(turnStart, false).pairing).toBeUndefined();
    const otherChat = { ...(turnStart as object), threadId: "t-2" } as never;
    expect(attachHelixMessagePairing(otherChat, true).pairing).toBeUndefined();
    const answer = { ...(turnStart as object), asyncUserInputResponse: {} } as never;
    expect(attachHelixMessagePairing(answer, true).pairing).toBeUndefined();
    const meta = { type: "thread.meta.update", commandId: "c", threadId: "t-1" } as never;
    expect(attachHelixMessagePairing(meta, true).command).toBe(meta);
  });
});

describe("resolveHelixControlState", () => {
  it("shows the chat's actual pairing until the control is touched", () => {
    expect(
      resolveHelixControlState({
        choice: undefined,
        pairActive: true,
        configuredBuilder: claude,
        pendingChange: null,
      }),
    ).toEqual({ on: true, builder: claude, touched: false, pending: false });
    expect(
      resolveHelixControlState({
        choice: undefined,
        pairActive: false,
        configuredBuilder: claude,
        pendingChange: null,
      }),
    ).toEqual({ on: false, builder: null, touched: false, pending: false });
  });

  it("shows a touched choice over the pair", () => {
    expect(
      resolveHelixControlState({
        choice: { enabled: false },
        pairActive: true,
        configuredBuilder: claude,
        pendingChange: null,
      }),
    ).toEqual({ on: false, builder: null, touched: true, pending: false });
  });

  it("shows the server's pending change while the Builder works", () => {
    expect(
      resolveHelixControlState({
        choice: undefined,
        pairActive: true,
        configuredBuilder: claude,
        pendingChange: { kind: "builder", builderModelSelection: codex },
      }),
    ).toEqual({ on: true, builder: codex, touched: false, pending: true });
    expect(
      resolveHelixControlState({
        choice: undefined,
        pairActive: true,
        configuredBuilder: claude,
        pendingChange: { kind: "disable" },
      }),
    ).toMatchObject({ on: false, pending: true });
  });
});

describe("recordHelixPairingOutcome", () => {
  it("consumes the sent choice and keeps a newer one", async () => {
    setHelixDraftChoice("t-1", on(codex));
    const sent = stored("t-1");
    await recordHelixPairingOutcome("t-1", sent, { status: "unchanged" });
    expect(useHelixDraftStore.getState().choiceByThreadId.has("t-1")).toBe(false);

    setHelixDraftChoice("t-1", on(codex));
    const resent = stored("t-1");
    setHelixDraftChoice("t-1", on(claude));
    const newer = stored("t-1");
    await recordHelixPairingOutcome("t-1", resent, { status: "applied" });
    expect(useHelixDraftStore.getState().choiceByThreadId.get("t-1")).toBe(newer);
  });

  it("reloads pair state before letting go of an applied or pending choice", async () => {
    const order: string[] = [];
    const off = onHelixPairingSettled(async (threadId) => {
      order.push(`reload:${threadId}`);
      expect(useHelixDraftStore.getState().choiceByThreadId.has(threadId)).toBe(true);
    });
    setHelixDraftChoice("t-1", on(codex));
    const sent = stored("t-1");
    await recordHelixPairingOutcome("t-1", sent, { status: "pending" });
    off();
    expect(order).toEqual(["reload:t-1"]);
    expect(useHelixDraftStore.getState().choiceByThreadId.has("t-1")).toBe(false);
  });

  it("treats a retried message's `unchanged` as settled: reload, no note", async () => {
    const reloads: string[] = [];
    const off = onHelixPairingSettled(async (threadId) => {
      reloads.push(threadId);
      expect(useHelixDraftStore.getState().choiceByThreadId.has(threadId)).toBe(true);
    });
    setHelixDraftChoice("t-1", on(codex));
    const sent = stored("t-1");
    await recordHelixPairingOutcome("t-1", sent, { status: "unchanged" });
    off();
    expect(reloads).toEqual(["t-1"]);
    expect(useHelixDraftStore.getState().choiceByThreadId.has("t-1")).toBe(false);
    expect(useHelixDraftStore.getState().noteByThreadId.has("t-1")).toBe(false);
  });

  it("names every not-applied reason, including not_permitted", () => {
    for (const reason of HelixPairingNotAppliedReason.literals) {
      expect(helixPairingNotAppliedMessageKey(reason)).toMatch(/^chat:helix_notApplied_/);
    }
    expect(helixPairingNotAppliedMessageKey("not_permitted")).toBe(
      "chat:helix_notApplied_notPermitted",
    );
    expect(helixPairingNotAppliedMessageKey("something_new")).toBeNull();
  });

  it("leaves a calm note when the server did not apply it", async () => {
    setHelixDraftChoice("t-1", { enabled: false });
    await recordHelixPairingOutcome("t-1", stored("t-1"), {
      status: "not_applied",
      reason: "unsupported_lead_provider",
      message: "server words",
    });
    expect(useHelixDraftStore.getState().noteByThreadId.get("t-1")).toEqual({
      reason: "unsupported_lead_provider",
      message: "server words",
      enabled: false,
    });
    // Touching the control again clears the note; so does dismissing it.
    setHelixDraftChoice("t-1", on(codex));
    expect(useHelixDraftStore.getState().noteByThreadId.has("t-1")).toBe(false);
    clearHelixDraftChoice("t-1");
    await recordHelixPairingOutcome("t-1", on(codex), { status: "not_applied" });
    dismissHelixPairingNote("t-1");
    expect(useHelixDraftStore.getState().noteByThreadId.has("t-1")).toBe(false);
  });
});

describe("contract-shaped Builder selection", () => {
  it("keeps only the contract's fields of a UI model object", () => {
    const uiModel = {
      provider: "claudeAgent",
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: { effort: "high" },
      supportsAutoMode: true,
      // Fields a picker's model row carries that the contract does not.
      label: "Claude Opus 5.5",
      isCustom: false,
    } as unknown as ModelSelection;
    setHelixDraftChoice("t-1", { enabled: true, builderModelSelection: uiModel });
    const stored = useHelixDraftStore.getState().choiceByThreadId.get("t-1");
    expect(stored).toEqual({
      enabled: true,
      builderModelSelection: {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: { effort: "high" },
        supportsAutoMode: true,
      },
    });
    expect(toContractHelixPairing({ enabled: false })).toEqual({ enabled: false });
  });
});

describe("draft choice persistence", () => {
  it("keeps touched choices in storage, with when and against which pair, until consumed", () => {
    setHelixDraftChoice("t-1", on(codex), { pairId: null, now: 1000 });
    setHelixDraftChoice("t-2", { enabled: false }, { pairId: "pair-2", now: 2000 });
    expect(JSON.parse(localStorage.getItem(HELIX_DRAFT_CHOICES_STORAGE_KEY) ?? "[]")).toEqual([
      ["t-1", { choice: on(codex), savedAt: 1000, pairId: null }],
      ["t-2", { choice: { enabled: false }, savedAt: 2000, pairId: "pair-2" }],
    ]);
    clearHelixDraftChoice("t-1");
    clearHelixDraftChoice("t-2");
    expect(localStorage.getItem(HELIX_DRAFT_CHOICES_STORAGE_KEY)).toBeNull();
  });

  it("reads back fresh entries only, and never a previous version's shape", async () => {
    const now = Date.now();
    localStorage.setItem(
      HELIX_DRAFT_CHOICES_STORAGE_KEY,
      JSON.stringify([
        ["fresh", { choice: { enabled: false }, savedAt: now - 1000, pairId: "p" }],
        [
          "old",
          {
            choice: { enabled: false },
            savedAt: now - HELIX_DRAFT_CHOICE_MAX_AGE_MS - 1,
            pairId: "p",
          },
        ],
      ]),
    );
    localStorage.setItem(
      "synara:helix:draft-choices:v1",
      JSON.stringify([["v1", { enabled: false }]]),
    );
    vi.resetModules();
    const fresh = await import("./helixDraftStore");
    expect([...fresh.useHelixDraftStore.getState().choiceByThreadId.keys()]).toEqual(["fresh"]);
    expect(localStorage.getItem("synara:helix:draft-choices:v1")).toBeNull();
  });
});

describe("stale choices", () => {
  const now = 10 * HELIX_DRAFT_CHOICE_MAX_AGE_MS;
  const stale = (
    choices: Array<[string, HelixMessagePairing, string | null, number?]>,
    pairs: Array<[string, Partial<HelixActualPairing>]>,
    options: { pairsKnown?: boolean; gone?: string[] } = {},
  ) =>
    staleHelixDraftChoices({
      choices: new Map(choices.map(([id, choice]) => [id, choice])),
      meta: new Map(
        choices.map(([id, , pairId, savedAt]) => [id, { savedAt: savedAt ?? now, pairId }]),
      ),
      now,
      pairs: new Map(
        pairs.map(([id, pair]) => [
          id,
          { pairId: "pair-1", active: true, builder: claude, pendingChange: null, ...pair },
        ]),
      ),
      pairsKnown: options.pairsKnown ?? true,
      chatExists: (id) => !(options.gone ?? []).includes(id),
    });

  it("keeps a pending turn-off for an active pair (the field case)", () => {
    expect(stale([["lead", { enabled: false }, "pair-1"]], [["lead", {}]])).toEqual([]);
  });

  it("drops a choice older than a day", () => {
    expect(
      stale(
        [["lead", { enabled: false }, "pair-1", now - HELIX_DRAFT_CHOICE_MAX_AGE_MS - 1]],
        [["lead", {}]],
      ),
    ).toEqual(["lead"]);
  });

  it("drops a choice made for a pair that was removed or replaced", () => {
    expect(stale([["lead", { enabled: false }, "pair-1"]], [])).toEqual(["lead"]);
    expect(stale([["lead", on(codex), "pair-1"]], [["lead", { pairId: "pair-9" }]])).toEqual([
      "lead",
    ]);
  });

  it("drops a choice that equals the actual pairing", () => {
    // Turned off elsewhere already.
    expect(stale([["lead", { enabled: false }, "pair-1"]], [["lead", { active: false }]])).toEqual([
      "lead",
    ]);
    // Back to the pair's own Builder.
    expect(stale([["lead", on(claude), "pair-1"]], [["lead", {}]])).toEqual(["lead"]);
    // A real change stays.
    expect(stale([["lead", on(codex), "pair-1"]], [["lead", {}]])).toEqual([]);
  });

  it("drops a choice for a chat that no longer exists", () => {
    expect(stale([["gone", on(codex), null]], [], { gone: ["gone"] })).toEqual(["gone"]);
  });

  it("keeps everything while the pairing is not known yet", () => {
    expect(stale([["lead", { enabled: false }, "pair-1"]], [], { pairsKnown: false })).toEqual([]);
  });

  it("clears a pending turn-off on Resume, and drops in bulk", () => {
    setHelixDraftChoice("a", { enabled: false });
    setHelixDraftChoice("b", on(codex));
    clearPendingHelixTurnOff("a");
    clearPendingHelixTurnOff("b");
    expect([...useHelixDraftStore.getState().choiceByThreadId.keys()]).toEqual(["b"]);
    dropHelixDraftChoices(["b"]);
    expect(useHelixDraftStore.getState().choiceByThreadId.size).toBe(0);
    expect(useHelixDraftStore.getState().choiceMetaByThreadId.size).toBe(0);
  });
});

describe("remembered Builder", () => {
  it("remembers the last Builder chosen and survives bad storage", () => {
    expect(readRememberedHelixBuilder()).toBeNull();
    setHelixDraftChoice("t-1", on(claude));
    expect(readRememberedHelixBuilder()).toMatchObject({ provider: "claudeAgent" });
    rememberHelixBuilder(codex);
    expect(readRememberedHelixBuilder()).toMatchObject({ provider: "codex", model: "gpt-5.5" });

    localStorage.setItem(HELIX_LAST_BUILDER_STORAGE_KEY, "{not json");
    expect(readRememberedHelixBuilder()).toBeNull();

    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
    expect(readRememberedHelixBuilder()).toBeNull();
    expect(() => rememberHelixBuilder(codex)).not.toThrow();
  });

  it("defaults to the remembered Builder, then this chat's model, then Codex", () => {
    expect(
      defaultHelixBuilder({ remembered: claude, chatSelection: codex, restrictions: {} }),
    ).toBe(claude);
    expect(defaultHelixBuilder({ remembered: null, chatSelection: codex, restrictions: {} })).toBe(
      codex,
    );
    const gemini = { provider: "antigravity", model: "Gemini 3.5 Flash" } as ModelSelection;
    expect(
      defaultHelixBuilder({
        remembered: null,
        chatSelection: gemini,
        restrictions: { antigravity: "Not in this version" },
      }),
    ).toMatchObject({ provider: "codex" });
    expect(
      defaultHelixBuilder({
        remembered: claude,
        chatSelection: null,
        restrictions: { claudeAgent: "x", codex: "y" },
      }),
    ).toBeNull();
  });
});
