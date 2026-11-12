// FILE: composerHelixControl.logic.ts
// Purpose: What the composer's Helix control shows, from the same pair summary the Helix
//          capsule reads. On/off never waits for the lazily loaded pair view: an active pair
//          is on whether it is idle, working, reviewing, held, still without a Builder, or
//          from an earlier build. The view only names the Builder; until it arrives the pill
//          still reads as on ("Helix · Builder"), never as the off button.
// Layer: Chat Helix UI logic
// Exports: isHelixPairShownOn, resolveComposerHelixControl, ComposerHelixControlView

import type {
  HelixMessagePairing,
  HelixPairSummary,
  HelixPairView,
  HelixPendingChange,
  ModelSelection,
} from "@synara/contracts";

import { t } from "~/i18n";
import { resolveHelixControlState } from "~/helix/helixDraftStore";
import { formatProviderModelOptionName } from "~/providerModelOptions";

/** The pair is running for this chat: the capsule shows a status and the control reads on. */
export function isHelixPairShownOn(
  summary: Pick<HelixPairSummary, "lifecycle" | "status"> | null,
): boolean {
  return summary !== null && summary.lifecycle === "active" && summary.status !== "disabled";
}

export interface ComposerHelixControlView {
  readonly on: boolean;
  readonly touched: boolean;
  /** The server holds a change until the Builder finishes. */
  readonly pending: boolean;
  /** The Builder the pill names; null while the pair view has not loaded. */
  readonly builder: ModelSelection | null;
  /** The pair as the server has it, for "back to as-is" and turning off. */
  readonly pairActive: boolean;
  readonly configuredBuilder: ModelSelection | null;
  readonly pendingChange: HelixPendingChange | null;
  /**
   * What an unsent choice would change: nothing, turn Helix on for a chat without a
   * pair, turn an active pair off, or give it another Builder.
   */
  readonly change: "none" | "turn-on" | "turn-off" | "builder";
  /** The pair's own Builder, for "Keep <Builder>"; null while unknown. */
  readonly currentBuilderName: string | null;
  /** The trigger's text: "Helix" off, "Helix · <Builder>" on, marked while unsent. */
  readonly label: string;
  /** The same, spelled out for assistive tech. */
  readonly ariaLabel: string;
}

function builderDisplayName(selection: ModelSelection | null): string | null {
  if (!selection) return null;
  const name = formatProviderModelOptionName({
    provider: selection.provider,
    slug: selection.model,
  });
  return name.length > 0 ? name : null;
}

export function resolveComposerHelixControl(input: {
  readonly settingOn: boolean;
  readonly summary: HelixPairSummary | null;
  readonly view: HelixPairView | null;
  readonly choice: HelixMessagePairing | undefined;
  readonly translate?: typeof t;
}): ComposerHelixControlView {
  const translate = input.translate ?? t;
  const pairActive = input.settingOn && isHelixPairShownOn(input.summary);
  // The view must belong to this pair (a removed and re-created pair gets a new id).
  const view =
    input.view && input.summary && input.view.pair.id === input.summary.pairId ? input.view : null;
  const configuredBuilder = view?.pair.config.builderModelSelection ?? null;
  // Newer servers put the pending change on the summary; earlier builds' pairs have it
  // nowhere (absent), which means none.
  const pendingChange =
    input.summary?.pendingChange !== undefined
      ? input.summary.pendingChange
      : (view?.pair.config.pendingChange ?? null);
  const state = resolveHelixControlState({
    choice: input.settingOn ? input.choice : undefined,
    pairActive,
    configuredBuilder,
    pendingChange,
  });
  const builderName = builderDisplayName(state.builder);
  const currentBuilderName = builderDisplayName(configuredBuilder);
  const change: ComposerHelixControlView["change"] = !state.touched
    ? "none"
    : !state.on
      ? pairActive
        ? "turn-off"
        : "none"
      : pairActive
        ? "builder"
        : "turn-on";
  // An unsent change reads like other next-turn changes in the composer: the new value,
  // marked "(next message)".
  const label =
    change === "turn-off"
      ? translate("chat:helix_controlPendingOffLabel")
      : change === "builder"
        ? translate("chat:helix_controlPendingBuilderLabel", {
            value0: builderName ?? translate("chat:helix_builder"),
          })
        : state.on
          ? translate("chat:helix_controlOnLabel", {
              value0: builderName ?? translate("chat:helix_builder"),
            })
          : translate("chat:helix_name");
  const ariaLabel =
    change === "turn-off"
      ? translate("chat:helix_controlPendingOffAria")
      : change === "builder"
        ? translate("chat:helix_controlPendingBuilderAria", {
            value0: builderName ?? translate("chat:helix_builder"),
            value1: currentBuilderName ?? translate("chat:helix_currentBuilder"),
          })
        : !state.on
          ? translate("chat:helix_controlOffAria")
          : builderName
            ? translate("chat:helix_controlOnAria", { value0: builderName })
            : translate("chat:helix_controlOnAriaBuilderLoading");
  return {
    on: state.on,
    touched: state.touched,
    pending: state.pending,
    builder: state.builder,
    pairActive,
    configuredBuilder,
    pendingChange,
    change,
    currentBuilderName,
    label,
    ariaLabel,
  };
}
