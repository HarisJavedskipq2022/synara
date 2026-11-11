// FILE: whatsNew/history.ts
// Purpose: Loads the full curated release history on demand.
// Layer: data loader for the "What's new" surfaces. `entries.ts` holds every
// release (hundreds of KB), so the launch path reads `latestEntries.ts` and asks
// for the history here only when the release notes can actually be shown.

import { sortEntriesByVersionDesc, type WhatsNewEntry } from "./logic";

let historyPromise: Promise<readonly WhatsNewEntry[]> | null = null;

/** Every curated release, newest first. The chunk loads once per session. */
export function loadWhatsNewHistory(): Promise<readonly WhatsNewEntry[]> {
  historyPromise ??= import("./entries").then(
    (module) => sortEntriesByVersionDesc(module.WHATS_NEW_ENTRIES),
    (error: unknown) => {
      // Let a later caller retry a chunk that failed to load.
      historyPromise = null;
      throw error;
    },
  );
  return historyPromise;
}
