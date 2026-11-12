import { HelixPairId, type ProviderHelixRoleContext } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { isSynaraGatewayToolName } from "../agentGateway/computerToolPermission.ts";
import {
  CLAUDE_HELIX_TOOL_NAMES,
  isHelixToolCallFromSubagent,
  shouldAutoApproveGatewayToolForSession,
} from "./helixToolApproval.ts";

const role = (value: "lead" | "builder"): ProviderHelixRoleContext => ({
  role: value,
  pairId: HelixPairId.makeUnsafe("helix-pair:approval"),
  promptVersion: "helix-roles/2",
  instructions: "x",
});

const LEAD_TOOLS = ["helix_delegate", "helix_wait", "helix_inspect", "helix_review"];
const NAMES = [
  ...LEAD_TOOLS.flatMap((tool) => [`mcp__synara__${tool}`, `synara_${tool}`, tool]),
  "mcp__synara__helix_report",
  "synara_helix_report",
  "helix_report",
  "mcp__other__helix_delegate",
  "mcp__synara__helix_delegatex",
  "mcp__synara__synara_create_thread",
  "synara_list_threads",
  "mcp__synara__computer_click",
  "mcp__synara__browser_open",
  "Bash",
  "Edit",
  "Agent",
  "",
];

describe("Helix gateway tool auto-approval", () => {
  it("approves a Lead's four tools and a Builder's helix_report, server-qualified only", () => {
    for (const name of NAMES) {
      const bare = name.replace(/^mcp__synara__|^synara_/, "");
      const qualified = name !== bare;
      expect(shouldAutoApproveGatewayToolForSession({ helixRole: role("lead") }, name), name).toBe(
        qualified && LEAD_TOOLS.includes(bare),
      );
      expect(
        shouldAutoApproveGatewayToolForSession({ helixRole: role("builder") }, name),
        name,
      ).toBe(qualified && bare === "helix_report");
    }
  });

  it("keeps the old rule exactly for sessions without a Helix role", () => {
    for (const autoApproveSynaraTools of [true, false, undefined]) {
      for (const name of NAMES) {
        expect(shouldAutoApproveGatewayToolForSession({ autoApproveSynaraTools }, name), name).toBe(
          autoApproveSynaraTools === true && isSynaraGatewayToolName(name),
        );
      }
    }
  });

  it("prompts a plan-mode Lead for the tools that start or settle Builder work", () => {
    const lead = { helixRole: role("lead"), interactionMode: "plan" as const };
    expect(shouldAutoApproveGatewayToolForSession(lead, "mcp__synara__helix_delegate")).toBe(false);
    expect(shouldAutoApproveGatewayToolForSession(lead, "mcp__synara__helix_review")).toBe(false);
    expect(shouldAutoApproveGatewayToolForSession(lead, "mcp__synara__helix_wait")).toBe(true);
    expect(shouldAutoApproveGatewayToolForSession(lead, "mcp__synara__helix_inspect")).toBe(true);
    expect(
      shouldAutoApproveGatewayToolForSession(
        { helixRole: role("lead"), interactionMode: "default" },
        "mcp__synara__helix_delegate",
      ),
    ).toBe(true);
    // Plan mode changes nothing for sessions without a role.
    expect(
      shouldAutoApproveGatewayToolForSession(
        { autoApproveSynaraTools: true, interactionMode: "plan" },
        "mcp__synara__helix_delegate",
      ),
    ).toBe(true);
  });

  it("names every Helix tool a participant's sub-agent calls, and nothing else", () => {
    for (const toolName of CLAUDE_HELIX_TOOL_NAMES) {
      expect(
        isHelixToolCallFromSubagent({ helixRole: role("lead"), fromSubagent: true, toolName }),
      ).toBe(true);
      expect(
        isHelixToolCallFromSubagent({ helixRole: role("lead"), fromSubagent: false, toolName }),
      ).toBe(false);
      expect(isHelixToolCallFromSubagent({ fromSubagent: true, toolName })).toBe(false);
    }
    expect(CLAUDE_HELIX_TOOL_NAMES).toHaveLength(5);
    for (const toolName of [
      "Read",
      "mcp__synara__synara_list_threads",
      "mcp__other__helix_delegate",
    ]) {
      expect(
        isHelixToolCallFromSubagent({ helixRole: role("lead"), fromSubagent: true, toolName }),
      ).toBe(false);
    }
  });
});
