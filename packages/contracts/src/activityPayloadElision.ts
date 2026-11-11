// FILE: activityPayloadElision.ts
// Purpose: Drop stored activity payload fields that no client reads before a thread
//          detail snapshot goes over the wire.
// Layer: Contracts (pure helper shared by the server read path and the web guard test)
// Exports: elideUnreadActivityPayloadFields
// Note: read path only. Stored rows, live events, and server-side readers keep the
//       full payload; only the client thread-detail snapshot is thinned.

import type { OrchestrationThreadActivity } from "./orchestration";

type ActivityPayload = OrchestrationThreadActivity["payload"];
type JsonRecord = { readonly [key: string]: ActivityPayload };

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function withoutKey(record: JsonRecord, key: string): JsonRecord {
  const { [key]: _omitted, ...rest } = record;
  return rest;
}

// Codex file changes carry each file's patch at `changes[i].diff`. Clients read the
// change paths and kinds; the per-change patch text is never read.
function elideChangeDiffs(changes: ReadonlyArray<ActivityPayload>): ReadonlyArray<ActivityPayload> {
  let changed = false;
  const next = changes.map((change) => {
    const record = asRecord(change);
    if (!record || typeof record.diff !== "string") return change;
    changed = true;
    return withoutKey(record, "diff");
  });
  return changed ? next : changes;
}

/**
 * Remove the bulky provider fields no client reads, so a long thread's first open
 * does not decode, encode, compress and parse megabytes nobody renders.
 *
 * Elided (all inside `payload.data.item`, the raw Codex item):
 * - `aggregatedOutput`: a command's captured output (up to the 16 KB activity cap).
 * - `changes[i].diff`: a file change's per-file patch.
 *
 * Every other field, including Claude/OpenCode/ACP `rawOutput`, `result`, `input`
 * and edit texts that collapsed rows and expanded details do read, is kept.
 *
 * Rule for a new client reader of an elided field: remove the field from this
 * function first. Even when the full payload arrived live, the client store can end
 * up holding the elided copy of a settled-turn activity, because a later snapshot
 * replaces it (`normalizeActivities` keeps the incoming copy when the detail scores
 * tie). The web guard test (`apps/web/src/activityPayloadElision.test.ts`) compares
 * the pure client consumers of activities with and without elision and scans client
 * sources for these field names; see its header for what it does not cover.
 *
 * Returns the input by reference when nothing was elided.
 */
export function elideUnreadActivityPayloadFields(payload: ActivityPayload): ActivityPayload {
  const root = asRecord(payload);
  const data = asRecord(root?.data);
  const item = asRecord(data?.item);
  if (!root || !data || !item) return payload;

  let nextItem = item;
  if (typeof item.aggregatedOutput === "string") {
    nextItem = withoutKey(nextItem, "aggregatedOutput");
  }
  if (Array.isArray(item.changes)) {
    const changes = elideChangeDiffs(item.changes);
    if (changes !== item.changes) nextItem = { ...nextItem, changes };
  }
  if (nextItem === item) return payload;
  return { ...root, data: { ...data, item: nextItem } };
}
