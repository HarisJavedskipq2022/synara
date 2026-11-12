// FILE: useHelix.ts
// Purpose: React access to Helix state through narrow selectors, so a chat without a
//          pair never re-renders when another chat's pair changes. Helix renders only
//          while the server offers it and the `enableHelix` setting is on; Builder
//          threads stay out of thread lists either way.
// Layer: Web Helix hooks
// Exports: useHelixEnabled, useHelixLeadSummary, useHelixBuilderLeadThreadId,
//          useHelixBuilderThreadIds, useHelixLeadDetail, useHelixSidebarStatuses

import type { HelixPairSummary, ThreadId } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import { useStore } from "~/store";
import { resolveHelixChatStatus, type HelixRowStatus } from "./helixPresentation";
import { selectHelixBuilderThreadIds, useHelixStore, type HelixLeadDetail } from "./helixStore";
import { retainHelixLeadDetail, retainHelixPairsSync } from "./helixSync";

function selectEnableHelix(settings: { readonly enableHelix?: boolean }): boolean {
  return settings.enableHelix === true;
}

/** True while the server offers Helix and its `enableHelix` setting is on. */
export function useHelixEnabled(): boolean {
  const supported = useHelixStore((state) => state.supported);
  const settingOn = useQuery({ ...serverSettingsQueryOptions(), select: selectEnableHelix });
  return supported && settingOn.data === true;
}

/** The pair whose Lead is this thread, or null. Keeps pair summaries live while mounted. */
export function useHelixLeadSummary(threadId: string | null | undefined): HelixPairSummary | null {
  useEffect(() => retainHelixPairsSync(), []);
  return useHelixStore((state) =>
    threadId ? (state.summaryByLeadThreadId.get(threadId) ?? null) : null,
  );
}

/** The Lead thread of the pair whose Builder is this thread, or null. */
export function useHelixBuilderLeadThreadId(threadId: string | null | undefined): ThreadId | null {
  useEffect(() => retainHelixPairsSync(), []);
  return useHelixStore((state) =>
    threadId ? (state.leadByBuilderThreadId.get(threadId) ?? null) : null,
  );
}

/** Every Builder thread id, active and disabled pairs alike, for list filtering. */
export function useHelixBuilderThreadIds(): ReadonlySet<string> {
  useEffect(() => retainHelixPairsSync(), []);
  return useHelixStore(selectHelixBuilderThreadIds);
}

const IDLE_DETAIL: HelixLeadDetail = { status: "loading", view: null, error: null };

/** The full pair view for an open Lead chat; pass null to load nothing. */
export function useHelixLeadDetail(leadThreadId: ThreadId | null): HelixLeadDetail {
  useEffect(() => (leadThreadId ? retainHelixLeadDetail(leadThreadId) : undefined), [leadThreadId]);
  return useHelixStore((state) =>
    leadThreadId ? (state.detailByLeadThreadId.get(leadThreadId) ?? IDLE_DETAIL) : IDLE_DETAIL,
  );
}

export type HelixSidebarStatus = HelixRowStatus;

const EMPTY_SIDEBAR_STATUSES: ReadonlyMap<string, HelixSidebarStatus> = new Map();
const EMPTY_SUMMARIES: ReadonlyMap<string, HelixPairSummary> = new Map();

function buildSidebarStatuses(
  summaries: ReadonlyMap<string, HelixPairSummary>,
  builderFlags: readonly string[],
): ReadonlyMap<string, HelixSidebarStatus> {
  const statuses = new Map<string, HelixSidebarStatus>();
  let index = 0;
  for (const summary of summaries.values()) {
    const flags = builderFlags[index] ?? "00";
    index += 1;
    const status = resolveHelixChatStatus({
      summary,
      leadWorking: false,
      latestState: summary.latestHandoffState ?? null,
    });
    if (status === null) continue;
    statuses.set(summary.leadThreadId, {
      status,
      builderHasPendingApprovals: flags[0] === "1",
      builderHasPendingUserInput: flags[1] === "1",
    });
  }
  return statuses;
}

/** Lead thread id → its sidebar status, for active pairs. Empty while Helix is off. */
export function useHelixSidebarStatuses(enabled: boolean): ReadonlyMap<string, HelixSidebarStatus> {
  const summaries = useHelixStore((state) =>
    enabled ? state.summaryByLeadThreadId : EMPTY_SUMMARIES,
  );
  // One "approval,input" flag pair per Builder, so rows repaint only when a flag flips.
  const builderFlags = useStore(
    useShallow((state) => {
      const flags: string[] = [];
      for (const summary of summaries.values()) {
        const builder = state.sidebarThreadSummaryById[summary.builderThreadId];
        flags.push(
          `${builder?.hasPendingApprovals ? 1 : 0}${builder?.hasPendingUserInput ? 1 : 0}`,
        );
      }
      return flags;
    }),
  );
  return useMemo(
    () =>
      summaries.size === 0 ? EMPTY_SIDEBAR_STATUSES : buildSidebarStatuses(summaries, builderFlags),
    [summaries, builderFlags],
  );
}
