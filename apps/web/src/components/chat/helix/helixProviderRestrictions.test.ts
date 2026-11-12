import { ProviderKind, helixRoleSupport } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { helixProviderRestrictions } from "./helixProviderRestrictions";

describe("helixProviderRestrictions", () => {
  it("allows only Claude and Codex, with the shared reason for every other provider", () => {
    const restrictions = helixProviderRestrictions(null, "builder");
    expect(restrictions.codex).toBeUndefined();
    expect(restrictions.claudeAgent).toBeUndefined();
    for (const provider of ProviderKind.literals) {
      if (provider === "codex" || provider === "claudeAgent") continue;
      const support = helixRoleSupport(provider, "builder");
      expect(support.supported).toBe(false);
      expect(restrictions[provider]).toBe(support.supported ? undefined : support.reason);
    }
  });

  it("prefers what the server reports", () => {
    const restrictions = helixProviderRestrictions(
      {
        enabled: true,
        defaultLimits: { maxCorrectionsPerWorkItem: 3, maxDispatchesPerGoal: 20 },
        providers: [
          {
            provider: "codex",
            lead: { supported: true, reason: null },
            builder: { supported: false, reason: "Codex is busy upgrading." },
          },
        ],
      },
      "builder",
    );
    expect(restrictions.codex).toBe("Codex is busy upgrading.");
    expect(restrictions.claudeAgent).toBeUndefined();
  });
});
