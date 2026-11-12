// FILE: useHelixLeadEligible.ts
// Purpose: Whether a chat may lead a Helix pair, for the composer's Helix control: an
//          ordinary chat (server or not-yet-started draft), never a Builder, a sub-agent,
//          a side chat, a Hub thread or coordinator, nor a chat whose pair data the server
//          cannot read (its notice offers Remove instead). The server refuses the rest.
// Layer: Chat Helix UI
// Exports: useHelixLeadEligible

import type { ThreadId } from "@synara/contracts";

import {
  useCoordinatorThreadIds,
  useProjectAgentSummariesStore,
} from "~/components/chat/project/useProjectAgentSummaries";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useHelixBuilderLeadThreadId } from "~/helix/useHelix";
import { useHelixStore } from "~/helix/helixStore";
import { useStore } from "~/store";

export function useHelixLeadEligible(threadId: ThreadId): boolean {
  const builderLead = useHelixBuilderLeadThreadId(threadId);
  const coordinatorThreadIds = useCoordinatorThreadIds();
  const serverProjectId = useStore((state) => {
    const thread = state.sidebarThreadSummaryById[threadId];
    if (thread === undefined) return undefined;
    return (thread.parentThreadId ?? null) === null &&
      (thread.sidechatSourceThreadId ?? null) === null
      ? thread.projectId
      : null;
  });
  const draftProjectId = useComposerDraftStore(
    (state) => state.draftThreadsByThreadId[threadId]?.projectId ?? null,
  );
  // undefined: no server thread yet, so the draft's project decides.
  const projectId = serverProjectId === undefined ? draftProjectId : serverProjectId;
  // A Hub member (a thread of a Hub's project, or one listed in a Hub's members) cannot lead.
  const isHubMember = useProjectAgentSummariesStore((state) => {
    if (projectId === null) return false;
    if (state.summariesByProjectId.get(projectId)?.configured === true) return true;
    for (const summary of state.summariesByProjectId.values()) {
      if (summary.memberThreadIds?.includes(threadId)) return true;
    }
    return false;
  });
  const quarantined = useHelixStore((state) => state.quarantinedByLeadThreadId.has(threadId));
  return (
    projectId !== null &&
    !isHubMember &&
    !quarantined &&
    builderLead === null &&
    !coordinatorThreadIds.has(threadId)
  );
}
