/**
 * Which gateway tools a Claude or Codex session may run without an
 * interactive provider prompt, and which Helix calls are refused outright.
 *
 * Which Helix tool belongs to which role is decided only by the shared rule
 * (`shouldAutoApproveSynaraGatewayTool`). This module adds what is specific to
 * the provider turn: plan mode keeps the Builder-starting tools on the prompt
 * path, and a participant's native sub-agents may not call Helix tools at all.
 * Only prompts the provider itself raises reach these checks, so a user's own
 * deny rule still wins; the gateway authorizes every call server-side.
 *
 * @module provider/helixToolApproval
 */
import {
  HELIX_TOOL_NAMES,
  type ProviderHelixRoleContext,
  type ProviderInteractionMode,
} from "@synara/contracts";

import {
  isHelixGatewayToolName,
  shouldAutoApproveSynaraGatewayTool,
} from "../agentGateway/computerToolPermission.ts";

/**
 * Lead tools that start or settle Builder work. A plan-mode turn may not edit,
 * so it may not have the Builder edit either without the user seeing a prompt.
 * `helix_wait` and `helix_inspect` are read-only (gateway annotations
 * `readOnlyHint: true`): they wait for or show state and start nothing.
 */
const HELIX_PLAN_MODE_PROMPTED_TOOLS = ["helix_delegate", "helix_review"] as const;

/** Claude names of every Helix tool, for per-agent `disallowedTools`. */
export const CLAUDE_HELIX_TOOL_NAMES: ReadonlyArray<string> = HELIX_TOOL_NAMES.map(
  (name) => `mcp__synara__${name}`,
);

/** A server-qualified Helix tool whose bare name is one of `names`. */
function isHelixToolNamed(toolName: unknown, names: ReadonlyArray<string>): boolean {
  if (!isHelixGatewayToolName(toolName)) return false;
  const normalized = (toolName as string).trim().toLowerCase();
  // The name is already a qualified catalog name, so its suffix is exact.
  return names.some((name) => normalized.endsWith(`_${name}`));
}

/**
 * A Helix tool called from a provider-native sub-agent of a participant. The
 * sub-agent inherits the participant's MCP connection and bearer, so without
 * this it could delegate or accept a result as the Lead. Always refused.
 */
export function isHelixToolCallFromSubagent(input: {
  readonly helixRole?: ProviderHelixRoleContext | undefined;
  readonly fromSubagent: boolean;
  readonly toolName: unknown;
}): boolean {
  return (
    input.helixRole !== undefined && input.fromSubagent && isHelixGatewayToolName(input.toolName)
  );
}

export function shouldAutoApproveGatewayToolForSession(
  input: {
    readonly autoApproveSynaraTools?: boolean | undefined;
    readonly helixRole?: ProviderHelixRoleContext | undefined;
    /** The turn's interaction mode; plan mode prompts for Builder-starting tools. */
    readonly interactionMode?: ProviderInteractionMode | undefined;
  },
  toolName: unknown,
): boolean {
  if (
    input.helixRole !== undefined &&
    input.interactionMode === "plan" &&
    isHelixToolNamed(toolName, HELIX_PLAN_MODE_PROMPTED_TOOLS)
  ) {
    return false;
  }
  return shouldAutoApproveSynaraGatewayTool(
    {
      autoApproveSynaraTools: input.autoApproveSynaraTools === true,
      ...(input.helixRole !== undefined ? { helixRole: input.helixRole } : {}),
    },
    toolName,
  );
}
