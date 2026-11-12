import type { HelixHandoff, HelixHold, HelixPairSummary } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { t } from "~/i18n";
import {
  canPauseHelixPair,
  canResumeHelixPair,
  canStopHelixPair,
  helixHandoffStateLabelKey,
  helixHoldReleaseKey,
  helixHoldTitleKey,
  helixLateResultLabelKey,
  helixVerdictLabelKey,
  isHelixBuilderRunning,
  isHelixPairIdle,
  resolveHelixChatStatus,
  upsertHelixHandoff,
} from "./helixPresentation";

function summary(overrides: Partial<HelixPairSummary> = {}): HelixPairSummary {
  return {
    pairId: "helix-pair:1",
    projectId: "project-1",
    leadThreadId: "lead-1",
    builderThreadId: "builder-1",
    lifecycle: "active",
    status: "idle",
    hold: null,
    activeHandoffId: null,
    revision: 3,
    updatedAt: "2026-11-12T00:00:00.000Z",
    ...overrides,
  } as HelixPairSummary;
}

function hold(kind: HelixHold["kind"], limit: HelixHold["limit"] = null): HelixHold {
  return {
    kind,
    reason: "",
    limit,
    handoffId: null,
    epoch: 1,
    since: "2026-11-12T00:00:00.000Z",
  } as HelixHold;
}

describe("resolveHelixChatStatus", () => {
  it("shows Planning only while an idle pair's Lead is working", () => {
    expect(resolveHelixChatStatus({ summary: summary(), leadWorking: true })).toBe("planning");
    expect(resolveHelixChatStatus({ summary: summary(), leadWorking: false })).toBe("idle");
  });

  it("passes the pair's own statuses through", () => {
    for (const status of ["building", "reviewing", "paused", "stopped"] as const) {
      expect(resolveHelixChatStatus({ summary: summary({ status }), leadWorking: true })).toBe(
        status,
      );
    }
  });

  it("calls out an uncertain Builder delivery", () => {
    expect(
      resolveHelixChatStatus({
        summary: summary({ status: "needs_attention", hold: hold("uncertain") }),
        leadWorking: false,
      }),
    ).toBe("uncertain");
    expect(
      resolveHelixChatStatus({
        summary: summary({ status: "needs_attention" }),
        leadWorking: false,
        latestState: "uncertain",
      }),
    ).toBe("uncertain");
    expect(
      resolveHelixChatStatus({
        summary: summary({ status: "needs_attention", hold: hold("limit", "goal_dispatches") }),
        leadWorking: false,
      }),
    ).toBe("needs_attention");
  });

  it("shows nothing for a disabled pair", () => {
    expect(
      resolveHelixChatStatus({
        summary: summary({ lifecycle: "disabled", status: "disabled" }),
        leadWorking: true,
      }),
    ).toBeNull();
  });
});

describe("holds", () => {
  it("names every hold the web knows and what releases it", () => {
    const kinds: Array<[HelixHold["kind"], HelixHold["limit"]]> = [
      ["stop", null],
      ["pause", null],
      ["limit", "goal_dispatches"],
      ["limit", "work_item_corrections"],
      ["restart", null],
      ["uncertain", null],
    ];
    const titles = new Set<string>();
    for (const [kind, limit] of kinds) {
      const titleKey = helixHoldTitleKey({ kind, limit });
      const releaseKey = helixHoldReleaseKey({ kind, limit });
      expect(titleKey).not.toBeNull();
      expect(releaseKey).not.toBeNull();
      expect(t(titleKey!)).not.toMatch(/^chat:/);
      expect(t(releaseKey!, { value0: 20 })).not.toMatch(/^chat:/);
      titles.add(t(titleKey!));
    }
    expect(titles.size).toBe(kinds.length);
    expect(t(helixHoldTitleKey({ kind: "pause", limit: null })!)).toBe("You paused Helix");
    expect(
      t(helixHoldReleaseKey({ kind: "limit", limit: "goal_dispatches" })!, { value0: 20 }),
    ).toContain("20");
  });

  it("says the Builder's work will be shown when a restart holds a running handoff", () => {
    expect(helixHoldReleaseKey({ kind: "restart", limit: null }, true)).toBe(
      "chat:helix_release_restartRunning",
    );
    expect(t("chat:helix_release_restartRunning")).toContain("will be shown when it finishes");
  });

  it("has no sentence of its own for a hold kind it does not know", () => {
    const unknown = { kind: "quota", limit: null } as unknown as Pick<HelixHold, "kind" | "limit">;
    expect(helixHoldTitleKey(unknown)).toBeNull();
    expect(helixHoldReleaseKey(unknown)).toBeNull();
  });

  it("labels a late result by its reason", () => {
    expect(t(helixLateResultLabelKey("stop"))).toBe("Arrived after Stop");
    expect(t(helixLateResultLabelKey("uncertain_send"))).toBe("Arrived after an uncertain send");
    expect(t(helixLateResultLabelKey("interrupted"))).toBe("Arrived after an interruption");
    expect(t(helixLateResultLabelKey(undefined))).toBe("Arrived late");
  });

  it("reads a running Builder from the summary alone", () => {
    expect(isHelixBuilderRunning({ activeHandoffId: null, latestHandoffState: "running" })).toBe(
      true,
    );
    expect(isHelixBuilderRunning({ activeHandoffId: null, latestHandoffState: "accepted" })).toBe(
      false,
    );
    expect(isHelixBuilderRunning({ activeHandoffId: null })).toBe(false);
  });
});

describe("controls", () => {
  it("offers configuration only while nothing is in flight or awaiting review", () => {
    expect(isHelixPairIdle(summary())).toBe(true);
    expect(isHelixPairIdle(summary({ activeHandoffId: "helix-handoff:1" as never }))).toBe(false);
    expect(isHelixPairIdle(summary({ status: "reviewing" }))).toBe(false);
    expect(isHelixPairIdle(summary({ lifecycle: "disabled", status: "disabled" }))).toBe(false);
    // A held pair with no active handoff is idle.
    expect(isHelixPairIdle(summary({ status: "paused", hold: hold("pause") }))).toBe(true);
  });

  it("offers Pause without a hold, Resume with one, and Stop unless already stopped", () => {
    expect(canPauseHelixPair(summary())).toBe(true);
    expect(canResumeHelixPair(summary())).toBe(false);
    const paused = summary({ status: "paused", hold: hold("pause") });
    expect(canPauseHelixPair(paused)).toBe(false);
    expect(canResumeHelixPair(paused)).toBe(true);
    expect(canStopHelixPair(paused)).toBe(true);
    expect(canStopHelixPair(summary({ status: "stopped", hold: hold("stop") }))).toBe(false);
  });
});

describe("verdict wording", () => {
  it("words every verdict as the Lead's, never as a user review", () => {
    for (const verdict of ["accepted", "changes_requested", "blocked"] as const) {
      expect(t(helixVerdictLabelKey(verdict))).toMatch(/^Lead /);
    }
    expect(t(helixHandoffStateLabelKey("accepted"))).toBe("Lead accepted");
    expect(t("chat:helix_verdictNote")).toContain("not your review");
  });
});

describe("upsertHelixHandoff", () => {
  const handoff = (id: string, sequence: number, revision: number) =>
    ({ id, sequence, revision, state: "running" }) as unknown as HelixHandoff;

  it("keeps newest first and never replaces a newer revision", () => {
    const list = upsertHelixHandoff([handoff("a", 1, 2)], handoff("b", 2, 0));
    expect(list.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(upsertHelixHandoff(list, handoff("a", 1, 1))).toBe(list);
    const updated = upsertHelixHandoff(list, handoff("a", 1, 3));
    expect(updated.find((entry) => entry.id === "a")?.revision).toBe(3);
  });
});
