// FILE: helixProviderRestrictions.ts
// Purpose: Which providers may not take a Helix role, each with the reason the pickers
//          show beside it. The server's capability answer wins; the shared rule covers an
//          older server or one still loading.
// Layer: Chat Helix UI
// Exports: helixProviderRestrictions

import {
  ProviderKind,
  helixRoleSupport,
  type HelixCapabilitiesResult,
  type HelixRole,
} from "@synara/contracts";

/** Why each provider may not take `role`: the server's answer, else the shared rule. */
export function helixProviderRestrictions(
  capabilities: HelixCapabilitiesResult | null,
  role: HelixRole,
): Partial<Record<ProviderKind, string>> {
  const restrictions: Partial<Record<ProviderKind, string>> = {};
  for (const provider of ProviderKind.literals) {
    const served = capabilities?.providers.find((entry) => entry.provider === provider)?.[role];
    const local = helixRoleSupport(provider, role);
    const localReason = local.supported ? null : local.reason;
    if (served ? !served.supported : !local.supported) {
      restrictions[provider] = served?.reason ?? localReason ?? "";
    }
  }
  return restrictions;
}
