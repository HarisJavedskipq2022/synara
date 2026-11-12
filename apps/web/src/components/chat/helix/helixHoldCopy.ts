// FILE: helixHoldCopy.ts
// Purpose: The words for a Helix hold: the chat's own second-person sentence for every
//          hold kind it knows, and the server's reason text only for a kind it does not.
// Layer: Chat Helix UI copy

import type { HelixHandoffState, HelixHold } from "@synara/contracts";

import { t } from "~/i18n";
import {
  helixHoldReleaseKey,
  helixHoldTitleKey,
  isHelixWakeFailureHold,
} from "~/helix/helixPresentation";

export interface HelixHoldCopy {
  readonly title: string;
  readonly release: string | null;
}

export function helixHoldCopy(
  hold: HelixHold,
  options: {
    readonly builderRunning: boolean;
    readonly maxDispatchesPerGoal: number | null;
    /** State of the handoff the hold names, when known: tells a failed wake from a send. */
    readonly holdHandoffState?: HelixHandoffState | null;
  },
): HelixHoldCopy {
  const wakeFailed = isHelixWakeFailureHold(hold, options.holdHandoffState ?? null);
  const titleKey = wakeFailed ? "chat:helix_hold_wakeFailed" : helixHoldTitleKey(hold);
  const releaseKey = wakeFailed
    ? "chat:helix_release_wakeFailed"
    : helixHoldReleaseKey(hold, options.builderRunning);
  return {
    title: titleKey ? t(titleKey) : hold.reason,
    release: releaseKey ? t(releaseKey, { value0: options.maxDispatchesPerGoal ?? "" }) : null,
  };
}
