// FILE: helixErrors.ts
// Purpose: Turn a helix.* RPC failure into one calm, specific message. The coordinator
//          is optional on a server (HELIX_UNAVAILABLE) and its mutations may still be
//          stubs (HELIX_NOT_IMPLEMENTED); neither is a crash, and no raw code is shown.
// Layer: Web Helix data
// Exports: HelixErrorKind, classifyHelixError, helixErrorMessageKey

import {
  HELIX_RPC_ERROR_CODES,
  type HelixPairingNotAppliedReason,
  type HelixRefusalReason,
} from "@synara/contracts";

export type HelixErrorKind =
  | "disabled"
  | "unavailable"
  | "not_implemented"
  | "not_found"
  | "stale_revision"
  | "conflict"
  | "invalid_transition"
  | "unsupported_provider"
  | "unsupported_thread"
  | "busy"
  | "unknown";

const KIND_BY_CODE: Readonly<Record<string, HelixErrorKind>> = {
  [HELIX_RPC_ERROR_CODES.disabled]: "disabled",
  [HELIX_RPC_ERROR_CODES.unavailable]: "unavailable",
  [HELIX_RPC_ERROR_CODES.notImplemented]: "not_implemented",
  [HELIX_RPC_ERROR_CODES.notFound]: "not_found",
  [HELIX_RPC_ERROR_CODES.staleRevision]: "stale_revision",
  [HELIX_RPC_ERROR_CODES.conflict]: "conflict",
  [HELIX_RPC_ERROR_CODES.invalidTransition]: "invalid_transition",
  [HELIX_RPC_ERROR_CODES.unsupportedProvider]: "unsupported_provider",
  [HELIX_RPC_ERROR_CODES.unsupportedThread]: "unsupported_thread",
  [HELIX_RPC_ERROR_CODES.pairBusy]: "busy",
};

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

export function classifyHelixError(error: unknown): HelixErrorKind {
  const code = errorCode(error);
  return (code !== null ? KIND_BY_CODE[code] : undefined) ?? "unknown";
}

const MESSAGE_KEY_BY_KIND: Readonly<Record<HelixErrorKind, string>> = {
  disabled: "chat:helix_error_disabled",
  unavailable: "chat:helix_error_unavailable",
  not_implemented: "chat:helix_error_notImplemented",
  not_found: "chat:helix_error_notFound",
  stale_revision: "chat:helix_error_staleRevision",
  conflict: "chat:helix_error_conflict",
  invalid_transition: "chat:helix_error_invalidTransition",
  unsupported_provider: "chat:helix_error_unsupportedProvider",
  unsupported_thread: "chat:helix_error_unsupportedThread",
  busy: "chat:helix_error_busy",
  unknown: "chat:helix_error_unknown",
};

/** The i18n key for the user-facing explanation of a failure kind. */
export function helixErrorMessageKey(kind: HelixErrorKind): string {
  return MESSAGE_KEY_BY_KIND[kind];
}

// Thread fields a Helix participant may not change: Lead and Builder share the workspace.
const WORKSPACE_FIELDS = [
  "envMode",
  "branch",
  "worktreePath",
  "workingDirectory",
  "associatedWorktreePath",
  "associatedWorktreeBranch",
  "associatedWorktreeRef",
  "parentThreadId",
  "handoff",
] as const;

/**
 * The server refuses some ordinary orchestration commands on a Helix participant, all
 * with HELIX_UNSUPPORTED_THREAD. The command (and whether its thread is a Builder) tells
 * which refusal it was, so the chat can say exactly what to do instead.
 */
export function helixCommandRefusalMessageKey(
  command: { readonly type: string } & Readonly<Record<string, unknown>>,
  isBuilder: boolean,
): string {
  if (command.type === "thread.checkpoint.revert") return "chat:helix_refusal_revert";
  if (command.type === "thread.handoff.create") return "chat:helix_refusal_handoff";
  if (isBuilder) {
    if (command.type === "thread.archive" || command.type === "thread.delete") {
      return "chat:helix_refusal_builderArchive";
    }
    if (command.type === "thread.turn.start" || command.type === "thread.message.edit-and-resend") {
      return "chat:helix_refusal_builderMessage";
    }
    if (WORKSPACE_FIELDS.some((field) => command[field] !== undefined)) {
      return "chat:helix_refusal_builderWorkspace";
    }
    if (command.modelSelection !== undefined) return "chat:helix_refusal_builderModel";
    return "chat:helix_error_unsupportedThread";
  }
  if (WORKSPACE_FIELDS.some((field) => command[field] !== undefined)) {
    return "chat:helix_refusal_workspace";
  }
  if (command.modelSelection !== undefined) return "chat:helix_refusal_provider";
  return "chat:helix_error_unsupportedThread";
}

const REFUSAL_REASON_KEYS: Readonly<Record<HelixRefusalReason, string>> = {
  pair_active: "chat:helix_refusal_handoff",
  builder_read_only: "chat:helix_refusal_builderMessage",
  builder_follows_lead: "chat:helix_refusal_builderArchive",
  builder_workspace_fixed: "chat:helix_refusal_builderWorkspace",
  builder_model_in_settings: "chat:helix_refusal_builderModel",
  lead_workspace_locked: "chat:helix_refusal_workspace",
  lead_provider_unsupported: "chat:helix_refusal_provider",
  revert_builder_busy: "chat:helix_refusal_revertBuilderBusy",
  revert_lead_busy: "chat:helix_refusal_revertLeadBusy",
  revert_unknown: "chat:helix_refusal_revertUnknown",
  workspace_in_pair: "chat:helix_refusal_workspaceInPair",
};

/** The sentence for a refusal reason the server named; null for one this build does not know. */
export function helixRefusalReasonMessageKey(reason: string): string | null {
  return Object.hasOwn(REFUSAL_REASON_KEYS, reason)
    ? REFUSAL_REASON_KEYS[reason as HelixRefusalReason]
    : null;
}

const NOT_APPLIED_REASON_KEYS: Readonly<Record<HelixPairingNotAppliedReason, string>> = {
  setting_off: "chat:helix_notApplied_settingOff",
  unsupported_thread: "chat:helix_notApplied_unsupportedThread",
  unsupported_lead_provider: "chat:helix_notApplied_unsupportedLead",
  unsupported_builder_provider: "chat:helix_notApplied_unsupportedBuilder",
  builder_thread: "chat:helix_notApplied_builderThread",
  quarantined: "chat:helix_notApplied_quarantined",
  unavailable: "chat:helix_notApplied_unavailable",
  not_permitted: "chat:helix_notApplied_notPermitted",
};

/** Why a message's Helix change was not applied; null for a reason this build does not know. */
export function helixPairingNotAppliedMessageKey(reason: string): string | null {
  return Object.hasOwn(NOT_APPLIED_REASON_KEYS, reason)
    ? NOT_APPLIED_REASON_KEYS[reason as HelixPairingNotAppliedReason]
    : null;
}
