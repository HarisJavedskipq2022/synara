// FILE: helixMinuteClock.ts
// Purpose: One shared, visibility-aware clock that ticks once a minute while any Helix
//          line shows an elapsed time. Every subscriber reads the same value, so many
//          open Lead chats cost one interval, and none at all when no pair is working.
// Layer: Web Helix hooks
// Exports: useHelixMinuteClock, HELIX_MAY_BE_STUCK_MS, helixElapsedMinutes

import { useSyncExternalStore } from "react";

import { startVisibleInterval } from "~/lib/visibleInterval";

/** A Builder step running this long reads as "may be stuck". */
export const HELIX_MAY_BE_STUCK_MS = 3 * 60_000;

const MINUTE_MS = 60_000;
const listeners = new Set<() => void>();
let nowMs = Date.now();
let stopInterval: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    nowMs = Date.now();
    stopInterval = startVisibleInterval(() => {
      nowMs = Date.now();
      for (const notify of listeners) notify();
    }, MINUTE_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopInterval?.();
      stopInterval = null;
    }
  };
}

const noSubscription = () => () => undefined;
const readNow = () => nowMs;

/** Wall time, refreshed each minute while `enabled`; a frozen value otherwise. */
export function useHelixMinuteClock(enabled: boolean): number {
  return useSyncExternalStore(enabled ? subscribe : noSubscription, readNow, readNow);
}

/** Whole minutes from `startedAt` to `nowMs` (0 while under a minute). */
export function helixElapsedMinutes(startedAt: string, nowMs: number): number {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Math.floor((nowMs - started) / MINUTE_MS));
}
