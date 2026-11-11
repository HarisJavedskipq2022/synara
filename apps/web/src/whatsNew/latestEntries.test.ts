import { describe, expect, it } from "vitest";

import { APP_VERSION } from "../branding";
import { WHATS_NEW_ENTRIES } from "./entries";
import { loadWhatsNewHistory } from "./history";
import { LATEST_WHATS_NEW_ENTRIES } from "./latestEntries";
import { resolveWhatsNewState, sortEntriesByVersionDesc } from "./logic";

// Boot reads only `LATEST_WHATS_NEW_ENTRIES`; these checks keep its answers the
// same as the full history's, so the prompt and help menu cannot drift.
describe("LATEST_WHATS_NEW_ENTRIES", () => {
  it("is the head of the full history in display order", () => {
    const history = sortEntriesByVersionDesc(WHATS_NEW_ENTRIES);
    expect(LATEST_WHATS_NEW_ENTRIES.length).toBeGreaterThanOrEqual(3);
    expect(sortEntriesByVersionDesc(LATEST_WHATS_NEW_ENTRIES)).toEqual(
      history.slice(0, LATEST_WHATS_NEW_ENTRIES.length),
    );
  });

  it("is included in the full history exactly once", () => {
    for (const entry of LATEST_WHATS_NEW_ENTRIES) {
      expect(WHATS_NEW_ENTRIES.filter((candidate) => candidate === entry)).toHaveLength(1);
    }
  });

  it("decides the installed version's prompt exactly as the full history does", () => {
    expect(APP_VERSION).not.toBe("0.0.0");
    const lastSeenVersions = [null, "0.0.1", APP_VERSION, "999.0.0"];
    for (const entry of WHATS_NEW_ENTRIES) lastSeenVersions.push(entry.version);
    for (const lastSeenVersion of lastSeenVersions) {
      const fromLatest = resolveWhatsNewState({
        entries: LATEST_WHATS_NEW_ENTRIES,
        currentVersion: APP_VERSION,
        lastSeenVersion,
      });
      const fromHistory = resolveWhatsNewState({
        entries: WHATS_NEW_ENTRIES,
        currentVersion: APP_VERSION,
        lastSeenVersion,
      });
      expect(fromLatest.kind).toBe(fromHistory.kind);
      if (fromLatest.kind === "show" && fromHistory.kind === "show") {
        expect(fromLatest.currentEntry).toBe(fromHistory.currentEntry);
        expect(fromLatest.nextLastSeenVersion).toBe(fromHistory.nextLastSeenVersion);
      } else {
        expect(fromLatest).toEqual(fromHistory);
      }
    }
  });
});

describe("loadWhatsNewHistory", () => {
  it("resolves the full history newest-first", async () => {
    await expect(loadWhatsNewHistory()).resolves.toEqual(
      sortEntriesByVersionDesc(WHATS_NEW_ENTRIES),
    );
  });
});
