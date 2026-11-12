// FILE: helixTone.ts
// Purpose: Text tones for Helix states, in the same hues the subagent and workflow rows use.
// Layer: Chat Helix styling

import type { HelixTone } from "~/helix/helixPresentation";

const TONE_CLASS_NAMES: Readonly<Record<HelixTone, string>> = {
  live: "text-sky-600 dark:text-sky-300/85",
  success: "text-emerald-700 dark:text-emerald-300/85",
  warning: "text-amber-700 dark:text-amber-300/85",
  danger: "text-rose-600 dark:text-rose-300/85",
  muted: "text-muted-foreground",
};

export function helixToneClassName(tone: HelixTone): string {
  return TONE_CLASS_NAMES[tone];
}
