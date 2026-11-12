// The field case: an active pair under a Stop hold whose Lead's composer holds an unsent
// "turn off" ({enabled:false}). The control, its popover, the capsule, the hold banner
// and the panel must all say it turns off with the next message, and taking it back
// (Keep Helix on, or Resume) restores "Helix · Claude Opus 5.5".
import type { HelixPairSummary, HelixPairView, ThreadId } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearHelixDraftChoice,
  clearPendingHelixTurnOff,
  setHelixDraftChoice,
  useHelixDraftStore,
} from "~/helix/helixDraftStore";
import { HelixHeldBannerView } from "./HelixActivityBanner";
import { HelixControlFooter, HelixKeepBuilderButton } from "./ComposerHelixControl";
import { HelixCapsuleLabel } from "./HelixComposerSection";
import { HelixPairPanel } from "./HelixPairPanel";
import { resolveComposerHelixControl } from "./composerHelixControl.logic";

const LEAD = "0edbd28d-67fc-42b7-83fe-579210121021" as ThreadId;
const summary = {
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
const view = {
  summary,
  pair: {
    id: "helix-pair:field",
    builderThreadId: "builder-field",
    builderCreatedAt: null,
    revision: 1,
    hold: summary.hold,
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
  },
  handoffs: [],
} as unknown as HelixPairView;

const noop = () => undefined;
const controlNow = () =>
  resolveComposerHelixControl({
    settingOn: true,
    summary,
    view,
    choice: useHelixDraftStore.getState().choiceByThreadId.get(LEAD),
  });
const pendingOffNow = () =>
  useHelixDraftStore.getState().choiceByThreadId.get(LEAD)?.enabled === false;

beforeEach(() => {
  useHelixDraftStore.setState({
    choiceByThreadId: new Map(),
    choiceMetaByThreadId: new Map(),
    noteByThreadId: new Map(),
  });
  // The user's stored choice.
  setHelixDraftChoice(LEAD, { enabled: false }, { pairId: summary.pairId });
});

describe("an unsent turn-off on a held active pair", () => {
  it("the control says so, in its label and its accessible label", () => {
    expect(controlNow()).toMatchObject({
      on: false,
      change: "turn-off",
      label: "Helix · off (next message)",
      ariaLabel: "Helix turns off with your next message. Open to keep it on",
    });
  });

  it("its popover offers Keep Helix on instead of turning it back on", () => {
    const footer = renderToStaticMarkup(
      <HelixControlFooter
        change={controlNow().change}
        on={controlNow().on}
        turnOnDisabled={false}
        onKeepOn={noop}
        onTurnOff={noop}
        onTurnOn={noop}
      />,
    );
    expect(footer).toContain("Keep Helix on");
    expect(footer).toContain('data-testid="composer-helix-keep-on"');
    expect(footer).not.toContain("Turn on Helix");
  });

  it("the capsule, the hold banner and the panel carry the same note", () => {
    expect(
      renderToStaticMarkup(<HelixCapsuleLabel status="stopped" pendingOff={pendingOffNow()} />),
    ).toContain("off next message");
    const banner = renderToStaticMarkup(
      <HelixHeldBannerView
        title="You stopped Helix"
        release="Press Resume, or send the Lead a new message, to continue."
        pendingOff={pendingOffNow()}
        canResume
        busy={false}
        onResume={noop}
      />,
    );
    expect(banner).toContain("Turns off with your next message.");
    const panel = renderToStaticMarkup(
      <HelixPairPanel
        pendingOff={pendingOffNow()}
        summary={summary}
        detail={{ status: "ready", view, error: null }}
        status="stopped"
        running={false}
        focusHandoffId={null}
        onOpenThread={noop}
        onChangeBuilder={noop}
      />,
    );
    expect(panel).toContain("Turns off with your next message.");
  });

  it("Keep Helix on restores the Builder pill and drops the notes", () => {
    clearHelixDraftChoice(LEAD);
    expect(controlNow()).toMatchObject({
      on: true,
      change: "none",
      label: "Helix · Claude Opus 5.5",
    });
    expect(
      renderToStaticMarkup(<HelixCapsuleLabel status="stopped" pendingOff={pendingOffNow()} />),
    ).not.toContain("off next message");
  });

  it("Resume takes back a pending turn-off, but not a pending Builder change", () => {
    clearPendingHelixTurnOff(LEAD);
    expect(controlNow().label).toBe("Helix · Claude Opus 5.5");

    setHelixDraftChoice(
      LEAD,
      { enabled: true, builderModelSelection: { provider: "codex", model: "gpt-5.5" } as never },
      { pairId: summary.pairId },
    );
    clearPendingHelixTurnOff(LEAD);
    expect(controlNow()).toMatchObject({
      change: "builder",
      label: "Helix · GPT-5.5 (next message)",
      ariaLabel:
        "The Builder changes to GPT-5.5 with your next message. Open to keep Claude Opus 5.5",
    });
    expect(
      renderToStaticMarkup(<HelixKeepBuilderButton builderName="Claude Opus 5.5" onClick={noop} />),
    ).toContain("Keep Claude Opus 5.5");
  });

  it("turning on a chat without a pair stays as it was", () => {
    expect(
      resolveComposerHelixControl({
        settingOn: true,
        summary: null,
        view: null,
        choice: {
          enabled: true,
          builderModelSelection: { provider: "codex", model: "gpt-5.5" } as never,
        },
      }),
    ).toMatchObject({ change: "turn-on", label: "Helix · GPT-5.5" });
  });
});
