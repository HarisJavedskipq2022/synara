import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HELIX_LIMITS,
  HELIX_BUILDER_TOOL_NAMES,
  HELIX_LEAD_TOOL_NAMES,
  HELIX_WS_METHODS,
  HelixDelegateToolInput,
  HelixReviewToolInput,
  HelixStreamEvent,
  ProviderHelixRoleContext,
  WS_HELIX_PAIRS_CAPABILITY,
  helixPairDisplayStatus,
  helixRoleSupport,
} from "./helix";
import { WsHelixRpcGroup } from "./helixRpc";
import {
  ClientOrchestrationCommand,
  DispatchResult,
  HelixPairingOutcome,
  ProviderKind,
} from "./orchestration";
import { WS_HELIX_MESSAGE_PAIRING_CAPABILITY, type HelixMessagePairing } from "./helix";
import { ProviderSessionStartInput } from "./provider";
import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerSettingsPatch } from "./settings";
import { WS_SERVER_CAPABILITIES } from "./wsCompatibility";

const hold = (kind: "stop" | "pause" | "limit" | "restart" | "uncertain") => ({
  lifecycle: "active" as const,
  hold: { kind, reason: "", limit: null, handoffId: null, epoch: 0, since: "now" },
});

describe("Helix contracts", () => {
  it("keeps Helix off by default and patchable", () => {
    expect(DEFAULT_SERVER_SETTINGS.enableHelix).toBe(false);
    expect(Schema.decodeUnknownSync(ServerSettings)({}).enableHelix).toBe(false);
    expect(Schema.decodeUnknownSync(ServerSettingsPatch)({ enableHelix: true })).toEqual({
      enableHelix: true,
    });
  });

  it("advertises the helix.pairs capability and serves every helix.* method", () => {
    expect(WS_SERVER_CAPABILITIES).toContain(WS_HELIX_PAIRS_CAPABILITY);
    expect([...WsHelixRpcGroup.requests.keys()].toSorted()).toEqual(
      Object.values(HELIX_WS_METHODS).toSorted(),
    );
  });

  it("qualifies only Claude and Codex, with a specific reason for every other provider", () => {
    for (const provider of ProviderKind.literals) {
      for (const role of ["lead", "builder"] as const) {
        const support = helixRoleSupport(provider, role);
        if (provider === "codex" || provider === "claudeAgent") {
          expect(support).toEqual({ supported: true });
        } else {
          expect(support.supported).toBe(false);
          if (!support.supported) expect(support.reason).toMatch(/^Unsupported in this version: /);
        }
      }
    }
  });

  it("names the role-exclusive tool families", () => {
    expect(HELIX_LEAD_TOOL_NAMES).toEqual([
      "helix_delegate",
      "helix_wait",
      "helix_inspect",
      "helix_review",
    ]);
    expect(HELIX_BUILDER_TOOL_NAMES).toEqual(["helix_report"]);
  });

  it("decodes tool inputs and refuses out-of-range waits and unknown verdicts", () => {
    const decode = Schema.decodeUnknownSync(HelixDelegateToolInput);
    expect(
      decode({
        requestId: "login-form",
        brief: { title: " T ", objective: "O", acceptanceCriteria: "A" },
      }).brief.title,
    ).toBe("T");
    expect(() =>
      decode({
        requestId: "x",
        brief: { title: "T", objective: "O", acceptanceCriteria: "A" },
        waitSeconds: 61,
      }),
    ).toThrow();
    expect(() =>
      decode({
        requestId: "bad id",
        brief: { title: "T", objective: "O", acceptanceCriteria: "A" },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(HelixReviewToolInput)({
        handoffId: "h",
        requestId: "r",
        verdict: "maybe",
      }),
    ).toThrow();
  });

  it("carries role instructions on session start without making them required", () => {
    const base = { threadId: "thread", runtimeMode: "auto" };
    expect(Schema.decodeUnknownSync(ProviderSessionStartInput)(base).helixRole).toBeUndefined();
    const role = { role: "builder", pairId: "pair", promptVersion: "v1", instructions: "Build." };
    expect(Schema.decodeUnknownSync(ProviderHelixRoleContext)(role).role).toBe("builder");
    expect(
      Schema.decodeUnknownSync(ProviderSessionStartInput)({ ...base, helixRole: role }).helixRole,
    ).toEqual(role);
  });

  it("derives the pair status chip", () => {
    const active = { lifecycle: "active" as const, hold: null };

    expect(helixPairDisplayStatus({ lifecycle: "disabled", hold: null }, null)).toBe("disabled");
    expect(helixPairDisplayStatus(hold("stop"), { state: "running" })).toBe("stopped");
    expect(helixPairDisplayStatus(hold("pause"), null)).toBe("paused");
    expect(helixPairDisplayStatus(hold("limit"), null)).toBe("needs_attention");
    expect(helixPairDisplayStatus(active, null)).toBe("idle");
    expect(helixPairDisplayStatus(active, { state: "dispatching" })).toBe("building");
    expect(helixPairDisplayStatus(active, { state: "awaiting_review" })).toBe("reviewing");
    expect(helixPairDisplayStatus(active, { state: "blocked" })).toBe("needs_attention");
    expect(helixPairDisplayStatus(active, { state: "accepted" })).toBe("idle");
  });

  it("decodes the stream snapshot", () => {
    expect(
      Schema.decodeUnknownSync(HelixStreamEvent)({ type: "snapshot", pairs: [], view: null }),
    ).toEqual({ type: "snapshot", pairs: [], view: null });
    expect(DEFAULT_HELIX_LIMITS).toEqual({
      maxCorrectionsPerWorkItem: 3,
      maxDispatchesPerGoal: 20,
    });
  });
});

const turnStart = (extra: Record<string, unknown> = {}) => ({
  type: "thread.turn.start",
  commandId: "c-1",
  threadId: "t-1",
  message: { messageId: "m-1", role: "user", text: "hi", attachments: [] },
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: "2026-11-12T10:00:00.000Z",
  ...extra,
});

describe("Helix pairing on a user message", () => {
  const decodeClient = Schema.decodeUnknownSync(ClientOrchestrationCommand);

  it("rides on thread.turn.start as on, off or absent", () => {
    const withOn = decodeClient(
      turnStart({
        helix: { enabled: true, builderModelSelection: { provider: "codex", model: "gpt-5" } },
      }),
    ) as { helix?: HelixMessagePairing };
    expect(withOn.helix?.enabled).toBe(true);
    const withOff = decodeClient(turnStart({ helix: { enabled: false } })) as {
      helix?: HelixMessagePairing;
    };
    expect(withOff.helix).toEqual({ enabled: false });
    // An old client sends nothing; an old server ignores the field.
    expect("helix" in (decodeClient(turnStart()) as object)).toBe(false);
    expect(() => decodeClient(turnStart({ helix: { enabled: true } }))).toThrow();
  });

  it("reports the outcome in DispatchResult, optional for older servers", () => {
    const decode = Schema.decodeUnknownSync(DispatchResult);
    expect(decode({ sequence: 3 })).toEqual({ sequence: 3 });
    expect(
      decode({
        sequence: 3,
        helixPairing: { status: "not_applied", reason: "setting_off", message: "off" },
      }).helixPairing?.reason,
    ).toBe("setting_off");
    expect(HelixPairingOutcome).toBeDefined();
    expect(WS_HELIX_MESSAGE_PAIRING_CAPABILITY).toBe("helix.message-pairing");
  });
});
