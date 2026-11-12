import type { HelixHold, HelixPairSummary, HelixPairView, ModelSelection } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { resolveHelixChatStatus } from "~/helix/helixPresentation";
import { isHelixPairShownOn, resolveComposerHelixControl } from "./composerHelixControl.logic";

const builder = { provider: "codex", model: "gpt-5.5" } as ModelSelection;

function summary(overrides: Partial<HelixPairSummary> = {}): HelixPairSummary {
  return {
    pairId: "pair-1",
    projectId: "project-1",
    leadThreadId: "lead-1",
    builderThreadId: "builder-1",
    lifecycle: "active",
    status: "idle",
    hold: null,
    activeHandoffId: null,
    latestHandoffState: null,
    revision: 3,
    updatedAt: "2026-11-12T00:00:00.000Z",
    ...overrides,
  } as HelixPairSummary;
}

/** A pair view; `earlierBuild` drops `pendingChange` like configs the previous build wrote. */
function view(
  options: {
    builderModel?: ModelSelection;
    earlierBuild?: boolean;
    builderCreatedAt?: string;
  } = {},
): HelixPairView {
  const config = {
    builderModelSelection: options.builderModel ?? builder,
    builderRuntimeMode: "full-access",
    limits: { maxCorrectionsPerWorkItem: 3, maxDispatchesPerGoal: 20 },
    rolePromptVersions: { lead: "helix-roles/2", builder: "helix-roles/2" },
    ...(options.earlierBuild ? {} : { pendingChange: null }),
  };
  return {
    summary: summary(),
    pair: {
      id: "pair-1",
      builderCreatedAt: options.builderCreatedAt ?? null,
      config,
      revision: 3,
    },
    handoffs: [],
  } as unknown as HelixPairView;
}

const stopHold = { kind: "stop", since: "2026-11-12T00:00:00.000Z" } as unknown as HelixHold;
const pauseHold = { kind: "pause", since: "2026-11-12T00:00:00.000Z" } as unknown as HelixHold;

function control(input: Partial<Parameters<typeof resolveComposerHelixControl>[0]>) {
  return resolveComposerHelixControl({
    settingOn: true,
    summary: summary(),
    view: view(),
    choice: undefined,
    ...input,
  });
}

describe("composer Helix control reflects the chat's actual pairing until touched", () => {
  const activeStates: Array<[string, Partial<HelixPairSummary>]> = [
    ["idle", { status: "idle" }],
    ["building", { status: "building", activeHandoffId: "h-1" as never }],
    ["reviewing", { status: "reviewing", latestHandoffState: "awaiting_review" as never }],
    ["held by Stop", { status: "stopped", hold: stopHold }],
    ["held by Pause", { status: "paused", hold: pauseHold }],
    [
      "needing attention",
      { status: "needs_attention", latestHandoffState: "interrupted" as never },
    ],
  ];

  for (const [name, overrides] of activeStates) {
    it(`an active pair ${name} reads on, names its Builder and offers Turn off`, () => {
      const result = control({ summary: summary(overrides) });
      expect(result).toMatchObject({ on: true, touched: false, pending: false, pairActive: true });
      expect(result.label).toBe("Helix · GPT-5.5");
      // The capsule shows a status for the same summary, so the two never disagree.
      expect(
        resolveHelixChatStatus({ summary: summary(overrides), leadWorking: false }),
      ).not.toBeNull();
    });
  }

  it("a held pair whose Builder was never created, written by the earlier build", () => {
    const result = control({
      summary: summary({ status: "stopped", hold: stopHold }),
      view: view({ earlierBuild: true }),
    });
    expect(result).toMatchObject({ on: true, pending: false, pendingChange: null });
    expect(result.label).toBe("Helix · GPT-5.5");
  });

  it("looks the Builder's display name up from its model slug", () => {
    const claude = { provider: "claudeAgent", model: "claude-opus-5-5" } as ModelSelection;
    expect(control({ view: view({ builderModel: claude }) }).label).toBe("Helix · Claude Opus 5.5");
    const unknown = { provider: "codex", model: "gpt-6.1-terra" } as ModelSelection;
    expect(control({ view: view({ builderModel: unknown }) }).label).toMatch(/^Helix · \S/);
  });

  it("still reads on while the pair view is loading, failed, or belongs to another pair", () => {
    for (const pairView of [null, { ...view(), pair: { ...view().pair, id: "pair-old" } }]) {
      const result = control({
        summary: summary({ status: "stopped", hold: stopHold }),
        view: pairView as HelixPairView | null,
      });
      expect(result).toMatchObject({ on: true, builder: null });
      expect(result.label).toBe("Helix · Builder");
    }
  });

  it("shows a pending change the server holds until the Builder finishes", () => {
    const claude = { provider: "claudeAgent", model: "claude-opus-5-5" } as ModelSelection;
    expect(
      control({
        summary: summary({
          status: "building",
          pendingChange: { kind: "builder", builderModelSelection: claude },
        }),
      }),
    ).toMatchObject({ on: true, pending: true, label: "Helix · Claude Opus 5.5" });
    expect(
      control({ summary: summary({ status: "building", pendingChange: { kind: "disable" } }) }),
    ).toMatchObject({ on: false, pending: true, label: "Helix" });
  });

  it("reads off for a turned-off pair, no pair, or the setting off", () => {
    expect(
      control({ summary: summary({ lifecycle: "disabled", status: "disabled" }) }),
    ).toMatchObject({ on: false, label: "Helix" });
    expect(control({ summary: null, view: null })).toMatchObject({ on: false, label: "Helix" });
    expect(control({ settingOn: false })).toMatchObject({ on: false, pairActive: false });
    // An inconsistent active-but-disabled summary shows no capsule, so the control is off too.
    expect(isHelixPairShownOn(summary({ status: "disabled" }))).toBe(false);
  });

  it("a touched choice wins over the pairing", () => {
    expect(
      control({ summary: summary({ hold: stopHold }), choice: { enabled: false } }),
    ).toMatchObject({ on: false, touched: true });
    expect(
      control({
        summary: null,
        view: null,
        choice: { enabled: true, builderModelSelection: builder },
      }),
    ).toMatchObject({ on: true, touched: true, label: "Helix · GPT-5.5" });
  });
});
