import { describe, expect, it } from "vitest";

import type { HelixRowStatus } from "../helix/helixPresentation";
import { resolveThreadStatusPill } from "./Sidebar.logic";

const idleThread = {
  interactionMode: "default",
  latestTurn: null,
  lastVisitedAt: undefined,
  session: null,
  updatedAt: "2026-11-12T00:00:00.000Z",
} as const;

const workingThread = {
  ...idleThread,
  hasLiveTailWork: true,
};

function helix(overrides: Partial<HelixRowStatus> = {}): HelixRowStatus {
  return {
    status: "idle",
    builderHasPendingApprovals: false,
    builderHasPendingUserInput: false,
    ...overrides,
  };
}

function label(thread: typeof idleThread | typeof workingThread, status: HelixRowStatus | null) {
  return (
    resolveThreadStatusPill({
      thread: thread as never,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      helix: status,
    })?.label ?? null
  );
}

describe("resolveThreadStatusPill for a Helix Lead", () => {
  it("leaves ordinary threads unchanged", () => {
    expect(label(idleThread, null)).toBeNull();
    expect(label(workingThread, null)).toBe("Working");
  });

  it("shows the pair status on the Lead's row", () => {
    expect(label(idleThread, helix({ status: "building" }))).toBe("Building");
    expect(label(workingThread, helix({ status: "reviewing" }))).toBe("Reviewing");
    expect(label(idleThread, helix({ status: "needs_attention" }))).toBe("Needs Attention");
    expect(label(idleThread, helix({ status: "uncertain" }))).toBe("Uncertain");
    expect(label(idleThread, helix({ status: "paused" }))).toBe("Paused");
    expect(label(idleThread, helix({ status: "stopped" }))).toBe("Stopped");
  });

  it("says Planning while an idle pair's Lead works, and nothing when it rests", () => {
    expect(label(workingThread, helix())).toBe("Planning");
    expect(label(idleThread, helix())).toBeNull();
  });

  it("puts the hidden Builder's requests on the Lead's row first", () => {
    expect(label(idleThread, helix({ status: "building", builderHasPendingApprovals: true }))).toBe(
      "Pending Approval",
    );
    expect(label(idleThread, helix({ status: "building", builderHasPendingUserInput: true }))).toBe(
      "Awaiting Input",
    );
  });
});

describe("Helix sidebar status from the summary alone", () => {
  it("shows Uncertain from the latest handoff state without the full view", async () => {
    const { resolveHelixChatStatus } = await import("../helix/helixPresentation");
    expect(
      resolveHelixChatStatus({
        summary: { lifecycle: "active", status: "needs_attention", hold: null },
        leadWorking: false,
        latestState: "uncertain",
      }),
    ).toBe("uncertain");
  });
});
