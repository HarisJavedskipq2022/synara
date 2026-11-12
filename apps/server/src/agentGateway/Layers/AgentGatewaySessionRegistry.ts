import { randomUUID } from "node:crypto";

import { Layer } from "effect";

import {
  AgentGatewaySessionRegistry,
  type AgentGatewayCapability,
  type AgentGatewayRoleProfile,
  type AgentGatewaySessionIdentity,
  type AgentGatewaySessionRegistryShape,
  type AgentGatewayWriteAuthority,
} from "../Services/AgentGatewaySessionRegistry.ts";

const PROVIDER_SESSION_CAPABILITIES = [
  "thread:read",
  "thread:write",
  "automation:write",
  "diagnostics:read",
  "browser:control",
  "device:control",
] as const;

/**
 * The capabilities a credential exposes under a role profile. `granted` is
 * what the credential was issued with (base plus requested additions). A
 * Builder sees only its own tool family; nothing it was issued survives.
 */
export function agentGatewayCapabilitiesForRoleProfile(
  granted: ReadonlySet<AgentGatewayCapability>,
  profile: AgentGatewayRoleProfile | null,
): ReadonlySet<AgentGatewayCapability> {
  if (profile === null) return granted;
  if (profile.kind === "helix_builder") return new Set<AgentGatewayCapability>(["helix:builder"]);
  if (profile.kind === "helix_retired") return new Set<AgentGatewayCapability>();
  return new Set<AgentGatewayCapability>([...granted, "helix:lead"]);
}

export function makeAgentGatewaySessionRegistry(options?: {
  readonly now?: () => number;
  readonly randomId?: () => string;
}): AgentGatewaySessionRegistryShape {
  const now = options?.now ?? Date.now;
  const randomId = options?.randomId ?? randomUUID;
  interface RegisteredSession {
    identity: AgentGatewaySessionIdentity;
    retiredWriteTurnId: string | undefined;
  }
  const sessions = new Map<string, RegisteredSession>();
  const sessionsByKey = new Map<string, RegisteredSession>();

  const disabledComputerThreads = new Set<string>();
  const roleProfiles = new Map<string, AgentGatewayRoleProfile>();
  const visibleIdentity = (identity: AgentGatewaySessionIdentity): AgentGatewaySessionIdentity => {
    const granted = disabledComputerThreads.has(identity.threadId)
      ? new Set(
          [...identity.capabilities].filter((capability) => capability !== "computer:control"),
        )
      : identity.capabilities;
    const profile = roleProfiles.get(identity.threadId) ?? null;
    if (profile === null) {
      return granted === identity.capabilities ? identity : { ...identity, capabilities: granted };
    }
    return {
      ...identity,
      capabilities: agentGatewayCapabilitiesForRoleProfile(granted, profile),
      roleProfile: profile,
    };
  };
  return {
    setThreadRoleProfile: (threadId, profile) => {
      if (profile === null) roleProfiles.delete(threadId);
      else roleProfiles.set(threadId, profile);
    },
    getThreadRoleProfile: (threadId) => roleProfiles.get(threadId) ?? null,
    setComputerControlEnabled: (threadId, enabled) => {
      if (enabled) disabledComputerThreads.delete(threadId);
      else {
        disabledComputerThreads.add(threadId);
        for (const row of sessionsByKey.values()) {
          if (row.identity.threadId !== threadId) continue;
          row.identity = {
            ...row.identity,
            capabilities: new Set(
              [...row.identity.capabilities].filter(
                (capability) => capability !== "computer:control",
              ),
            ),
          };
        }
      }
    },
    computerControlProvisioned: (threadId, provider) => {
      const candidates = [...sessionsByKey.values()].filter(
        (row) => row.identity.threadId === threadId && row.identity.provider === provider,
      );
      const latest = candidates.at(-1);
      if (!latest) return false;
      // Without a role profile: exactly the pre-Helix reading of the stored identity.
      return roleProfiles.has(threadId)
        ? visibleIdentity(latest.identity).capabilities.has("computer:control")
        : latest.identity.capabilities.has("computer:control");
    },
    issue: (threadId, provider, issueOptions) => {
      // Every provider runtime owns an independent credential. Replacement
      // runtimes overlap their predecessor during startup, and the outgoing
      // runtime revokes its own token during teardown. Reusing a token here
      // would therefore let old-session cleanup invalidate the replacement.
      const issuedAt = now();
      const sessionKey = `gateway-session:${randomId()}`;
      const token = `sagw_session_${randomId()}`;
      const identity: AgentGatewaySessionIdentity = {
        sessionKey,
        threadId,
        provider,
        issuedAt,
        capabilities: new Set<AgentGatewayCapability>([
          ...PROVIDER_SESSION_CAPABILITIES,
          ...(issueOptions?.additionalCapabilities ?? []).filter(
            (capability) =>
              capability !== "computer:control" || !disabledComputerThreads.has(threadId),
          ),
        ]),
      };
      const registered: RegisteredSession = {
        identity,
        retiredWriteTurnId: undefined,
      };
      sessions.set(token, registered);
      sessionsByKey.set(sessionKey, registered);
      // Without a role profile the issued identity is exactly the pre-Helix one.
      return { token, ...(roleProfiles.has(threadId) ? visibleIdentity(identity) : identity) };
    },
    verify: (token) => {
      const identity = sessions.get(token)?.identity;
      return identity ? visibleIdentity(identity) : null;
    },
    bindWriteAuthority: (token, turnId) => {
      const registered = sessions.get(token);
      if (!registered || registered.retiredWriteTurnId !== undefined) return null;
      const { identity } = registered;
      return {
        sessionKey: identity.sessionKey,
        threadId: identity.threadId,
        provider: identity.provider,
        turnId,
      } satisfies AgentGatewayWriteAuthority;
    },
    verifyWriteAuthority: (authority) => {
      const registered = sessionsByKey.get(authority.sessionKey);
      const identity = registered?.identity;
      return (
        identity !== undefined &&
        registered?.retiredWriteTurnId === undefined &&
        identity.threadId === authority.threadId &&
        identity.provider === authority.provider
      );
    },
    retireWriteAuthority: (token, turnId) => {
      const registered = sessions.get(token);
      if (!registered) return false;
      if (registered.retiredWriteTurnId !== undefined) {
        return registered.retiredWriteTurnId === turnId;
      }
      // Record A even when it never called a gateway tool. This is the
      // critical case: a detached request from A must not arrive during B and
      // become the first request to bind this credential.
      registered.retiredWriteTurnId = turnId;
      return true;
    },
    revoke: (token) => {
      const registered = sessions.get(token);
      if (!registered) return;
      sessions.delete(token);
      sessionsByKey.delete(registered.identity.sessionKey);
    },
    listRetiredWriteAuthorities: (threadId) => {
      const retired = [];
      for (const registered of sessionsByKey.values()) {
        if (registered.retiredWriteTurnId === undefined) continue;
        if (registered.identity.threadId !== threadId) continue;
        retired.push({
          sessionKey: registered.identity.sessionKey,
          provider: registered.identity.provider,
          retiredTurnId: registered.retiredWriteTurnId,
          issuedAt: registered.identity.issuedAt,
        });
      }
      return retired;
    },
  };
}

export const AgentGatewaySessionRegistryLive = Layer.sync(
  AgentGatewaySessionRegistry,
  makeAgentGatewaySessionRegistry,
);
