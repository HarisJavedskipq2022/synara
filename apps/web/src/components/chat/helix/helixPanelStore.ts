// FILE: helixPanelStore.ts
// Purpose: Which Lead chat's Helix panel is open, and which handoff it should show. A
//          compact handoff card in the timeline opens the panel at its handoff.
// Layer: Chat Helix UI state

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";

interface HelixPanelState {
  readonly threadId: ThreadId | null;
  readonly focusHandoffId: string | null;
}

export const useHelixPanelStore = create<HelixPanelState>(() => ({
  threadId: null,
  focusHandoffId: null,
}));

export function openHelixPanel(threadId: ThreadId, focusHandoffId: string | null = null) {
  useHelixPanelStore.setState({ threadId, focusHandoffId });
}

export function closeHelixPanel() {
  useHelixPanelStore.setState({ threadId: null, focusHandoffId: null });
}
