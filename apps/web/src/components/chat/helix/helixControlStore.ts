// FILE: helixControlStore.ts
// Purpose: Which chat's composer Helix popover is open, so the Helix panel's
//          "Change Builder" can open it after closing itself.
// Layer: Chat Helix UI state

import type { ThreadId } from "@synara/contracts";
import { create } from "zustand";

export const useHelixControlStore = create<{ readonly threadId: ThreadId | null }>(() => ({
  threadId: null,
}));

export function openHelixControl(threadId: ThreadId) {
  useHelixControlStore.setState({ threadId });
}

export function closeHelixControl() {
  useHelixControlStore.setState({ threadId: null });
}
