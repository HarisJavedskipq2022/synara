/**
 * Deterministic identities for Helix's server-originated work.
 *
 * Command ids are a pure function of (handoff, attempt) so a retry after a
 * crash re-dispatches the exact command the engine already has a receipt
 * for: an identical replay is accepted once, never twice. The command's
 * `createdAt` must be the frozen `HelixTurnIntent.createdAt`, because the
 * receipt fingerprint includes it.
 *
 * @module helix/identity
 */
import { createHash, randomUUID } from "node:crypto";

import type { HelixBrief, HelixBriefInput, HelixHandoffId, HelixPairId } from "@synara/contracts";

/** Every Helix-originated orchestration command id starts with this prefix. */
export const HELIX_COMMAND_ID_PREFIX = "helix:";

export function helixDispatchCommandId(handoffId: HelixHandoffId, attempt: number): string {
  return `${HELIX_COMMAND_ID_PREFIX}dispatch:${handoffId}:${attempt}`;
}

export function helixWakeCommandId(handoffId: HelixHandoffId, attempt: number): string {
  return `${HELIX_COMMAND_ID_PREFIX}wake:${handoffId}:${attempt}`;
}

/** Cheap pre-filter: any command without the prefix is never a Helix turn. */
export function isHelixCommandId(commandId: string | null | undefined): commandId is string {
  return typeof commandId === "string" && commandId.startsWith(HELIX_COMMAND_ID_PREFIX);
}

/** The request id of the correction handoff a changes_requested review creates. */
export function helixCorrectionRequestId(reviewedHandoffId: HelixHandoffId): string {
  return `correction:${reviewedHandoffId}`;
}

export function newHelixPairId(): HelixPairId {
  return `helix-pair:${randomUUID()}` as HelixPairId;
}

export function newHelixHandoffId(): HelixHandoffId {
  return `helix-handoff:${randomUUID()}` as HelixHandoffId;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/**
 * Digest of a request's content. Key order and absent optional fields do not
 * change it; any change to a field's value does.
 */
export function helixRequestFingerprint(
  input:
    | { readonly kind: "delegate"; readonly brief: HelixBriefInput }
    | { readonly kind: "correction"; readonly brief: HelixBrief },
): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}
