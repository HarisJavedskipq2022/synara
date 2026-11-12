// FILE: helixActions.ts
// Purpose: The Helix mutations the chat offers directly. Pause and Resume carry the
//          revision the client last saw; Stop carries none (Stop always wins). Turning
//          Helix on or off and changing the Builder ride on the next message instead
//          (see helixDraftStore). A stale revision reloads the pair instead of surfacing
//          an error, and every other failure becomes one specific, calm message.
// Layer: Web Helix actions
// Exports: HelixMutationResult, pauseHelixPair, resumeHelixPair, stopHelixPair, removeHelixPair

import type { HelixPairSummary, HelixPairView, NativeApi, ThreadId } from "@synara/contracts";

import { t } from "~/i18n";
import { readNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";
import { classifyHelixError, helixErrorMessageKey, type HelixErrorKind } from "./helixErrors";
import { reduceRemoved, useHelixStore } from "./helixStore";
import { applyHelixView, loadHelixPairs, refreshHelixLeadDetail } from "./helixSync";

export type HelixMutationResult =
  | { readonly ok: true; readonly view: HelixPairView }
  | { readonly ok: false; readonly error: HelixErrorKind };

type HelixApi = NonNullable<NativeApi["helix"]>;

// Failures after which the client's copy of the pair is probably behind.
const RELOAD_AFTER: ReadonlySet<HelixErrorKind> = new Set([
  "stale_revision",
  "busy",
  "conflict",
  "invalid_transition",
  "not_found",
]);

async function mutate(
  leadThreadId: ThreadId,
  failureTitleKey: string,
  run: (api: HelixApi) => Promise<HelixPairView>,
): Promise<HelixMutationResult> {
  const api = readNativeApi()?.helix;
  let result: HelixMutationResult;
  if (!api) {
    result = { ok: false, error: "unavailable" };
  } else {
    result = await run(api).then(
      (view): HelixMutationResult => ({ ok: true, view }),
      (error: unknown): HelixMutationResult => ({ ok: false, error: classifyHelixError(error) }),
    );
  }
  if (result.ok) {
    applyHelixView(leadThreadId, result.view);
    return result;
  }
  if (RELOAD_AFTER.has(result.error)) void refreshHelixLeadDetail(leadThreadId);
  const stale = result.error === "stale_revision";
  toastManager.add({
    type: stale ? "info" : "error",
    title: t(stale ? "chat:helix_refreshedTitle" : failureTitleKey),
    description: t(helixErrorMessageKey(result.error)),
  });
  return result;
}

export function pauseHelixPair(summary: HelixPairSummary): Promise<HelixMutationResult> {
  return mutate(summary.leadThreadId, "chat:helix_couldNotPause", (api) =>
    api.pause({ pairId: summary.pairId, expectedRevision: summary.revision }),
  );
}

export function resumeHelixPair(summary: HelixPairSummary): Promise<HelixMutationResult> {
  return mutate(summary.leadThreadId, "chat:helix_couldNotResume", (api) =>
    api.resume({ pairId: summary.pairId, expectedRevision: summary.revision }),
  );
}

/** Stop always wins: no expected revision. */
export function stopHelixPair(summary: HelixPairSummary): Promise<HelixMutationResult> {
  return mutate(summary.leadThreadId, "chat:helix_couldNotStop", (api) =>
    api.stop({ pairId: summary.pairId }),
  );
}

/**
 * Remove a pair outright (helix.removePair): the only way out for a pair whose data the
 * server cannot read. The Builder is archived and the Lead becomes an ordinary chat.
 */
export async function removeHelixPair(entry: {
  readonly pairId: string;
  readonly leadThreadId: string;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: HelixErrorKind }> {
  const remove = readNativeApi()?.helix?.removePair;
  const result = remove
    ? await remove({ pairId: entry.pairId }).then(
        () => ({ ok: true }) as const,
        (error: unknown) => ({ ok: false, error: classifyHelixError(error) }) as const,
      )
    : ({ ok: false, error: "unavailable" } as const);
  if (result.ok) {
    useHelixStore.setState((state) => reduceRemoved(state, entry.leadThreadId));
    void loadHelixPairs();
    return result;
  }
  toastManager.add({
    type: "error",
    title: t("chat:helix_couldNotRemove"),
    description: t(helixErrorMessageKey(result.error)),
  });
  return result;
}
