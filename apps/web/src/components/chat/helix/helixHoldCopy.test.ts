import type { HelixHold } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { helixHoldCopy } from "./helixHoldCopy";

const hold = (kind: string, reason: string) =>
  ({
    kind,
    reason,
    limit: null,
    handoffId: null,
    epoch: 0,
    since: "2026-11-12T00:00:00.000Z",
  }) as unknown as HelixHold;

describe("helixHoldCopy", () => {
  it("uses the chat's own sentence for a known hold, never the server's reason", () => {
    const copy = helixHoldCopy(hold("pause", "Paused by the user."), {
      builderRunning: false,
      maxDispatchesPerGoal: 20,
    });
    expect(copy.title).toBe("You paused Helix");
    expect(copy.title).not.toContain("Paused by the user");
  });

  it("falls back to the server's reason for a hold kind it does not know", () => {
    const copy = helixHoldCopy(hold("quota", "Your workspace quota is exhausted."), {
      builderRunning: false,
      maxDispatchesPerGoal: null,
    });
    expect(copy.title).toBe("Your workspace quota is exhausted.");
    expect(copy.release).toBeNull();
  });
});

describe("an uncertain hold", () => {
  it("reads as a failed wake when its handoff is not the uncertain send", () => {
    const copy = helixHoldCopy(hold("uncertain", "Helix could not wake the Lead…"), {
      builderRunning: false,
      maxDispatchesPerGoal: null,
      holdHandoffState: "awaiting_review",
    });
    expect(copy.title).toBe("Helix could not deliver the Builder's result to the Lead");
    expect(copy.release).toContain("The result is kept");
  });

  it("reads as an uncertain send when its handoff is uncertain or unknown", () => {
    for (const holdHandoffState of ["uncertain", null] as const) {
      const copy = helixHoldCopy(hold("uncertain", "x"), {
        builderRunning: false,
        maxDispatchesPerGoal: null,
        holdHandoffState,
      });
      expect(copy.title).toBe("Helix could not confirm the Builder received a brief");
    }
  });
});
