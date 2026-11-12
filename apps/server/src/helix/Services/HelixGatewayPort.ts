/**
 * HelixGatewayPort - what the gateway's helix_* tools call into.
 *
 * The gateway owns transport, capability filtering and input decoding; the
 * coordinator owns every decision. The gateway resolves `caller` from the
 * server-side credential only. The coordinator must still re-resolve the
 * caller's role from the pair tables and refuse a mismatch: a capability is
 * necessary, never sufficient.
 *
 * Until the coordinator provides this service, the gateway serves the tools
 * against `notImplementedHelixGatewayPort`, which fails every call with
 * `helix_not_implemented`.
 *
 * @module helix/Services/HelixGatewayPort
 */
import {
  HELIX_DEFAULT_WAIT_SECONDS,
  type HelixDelegateToolInput,
  type HelixHandoffWaitOutput,
  type HelixInspectToolInput,
  type HelixInspectToolOutput,
  type HelixReportToolInput,
  type HelixReportToolOutput,
  type HelixReviewToolInput,
  type HelixReviewToolOutput,
  type HelixRole,
  type HelixToolErrorCode,
  type HelixWaitToolInput,
  type ProviderKind,
  type ThreadId,
  type TurnId,
} from "@synara/contracts";
import { Effect, ServiceMap } from "effect";

import { GatewayToolError } from "../../agentGateway/toolRuntime.ts";

/** The authenticated caller of a helix_* tool, derived from its gateway credential. */
export interface HelixToolCaller {
  readonly threadId: ThreadId;
  /** The exact running turn the request was admitted under; null for read-only calls outside a turn. */
  readonly turnId: TurnId | null;
  readonly sessionKey: string;
  readonly provider: ProviderKind;
  /** From the credential's capability; the coordinator re-checks it against the pair tables. */
  readonly role: HelixRole;
}

export interface HelixGatewayPortShape {
  /** Lead. Creates (or replays) a handoff and waits up to `waitSeconds` (default 30). */
  readonly delegate: (
    caller: HelixToolCaller,
    input: HelixDelegateToolInput,
  ) => Effect.Effect<HelixHandoffWaitOutput, GatewayToolError>;
  /** Lead. Waits for a handoff's result. */
  readonly wait: (
    caller: HelixToolCaller,
    input: HelixWaitToolInput,
  ) => Effect.Effect<HelixHandoffWaitOutput, GatewayToolError>;
  /** Lead. Reads pair state and a handoff in full. Never blocks, never changes state. */
  readonly inspect: (
    caller: HelixToolCaller,
    input: HelixInspectToolInput,
  ) => Effect.Effect<HelixInspectToolOutput, GatewayToolError>;
  /** Lead. Records a verdict; changes_requested creates the next handoff and may wait for it. */
  readonly review: (
    caller: HelixToolCaller,
    input: HelixReviewToolInput,
  ) => Effect.Effect<HelixReviewToolOutput, GatewayToolError>;
  /** Builder. Stores the report draft for its running handoff. */
  readonly report: (
    caller: HelixToolCaller,
    input: HelixReportToolInput,
  ) => Effect.Effect<HelixReportToolOutput, GatewayToolError>;
}

export class HelixGatewayPort extends ServiceMap.Service<HelixGatewayPort, HelixGatewayPortShape>()(
  "synara/helix/Services/HelixGatewayPort",
) {}

export function helixToolError(
  code: HelixToolErrorCode,
  message: string,
  details?: unknown,
): GatewayToolError {
  return new GatewayToolError(code, message, details);
}

const notImplemented = () =>
  Effect.fail(
    helixToolError(
      "helix_not_implemented",
      "Helix is not available in this build yet. Continue without delegating.",
    ),
  );

export const notImplementedHelixGatewayPort: HelixGatewayPortShape = {
  delegate: notImplemented,
  wait: notImplemented,
  inspect: notImplemented,
  review: notImplemented,
  report: notImplemented,
};

/** The wait a tool call asked for, clamped by its schema; the default when omitted. */
export function helixWaitSeconds(input: { readonly waitSeconds?: number | undefined }): number {
  return input.waitSeconds ?? HELIX_DEFAULT_WAIT_SECONDS;
}
