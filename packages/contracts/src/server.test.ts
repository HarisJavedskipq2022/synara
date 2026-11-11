import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ServerProviderStatus, ServerRefreshProvidersInput } from "./server";

const decodeServerProviderStatus = Schema.decodeUnknownSync(ServerProviderStatus);

describe("ServerRefreshProvidersInput", () => {
  const decode = Schema.decodeUnknownSync(ServerRefreshProvidersInput);

  it("treats a missing force flag as an explicit refresh from older clients", () => {
    expect(decode({})).toEqual({});
    expect(decode({ force: false })).toEqual({ force: false });
    expect(decode({ force: true })).toEqual({ force: true });
  });

  it("stays readable by servers that predate the force flag", () => {
    // The payload and tagged request-body schemas before `force` existed accept
    // the new key instead of rejecting the request.
    expect(() => Schema.decodeUnknownSync(Schema.Struct({}))({ force: false })).not.toThrow();
    const legacyTaggedBody = Schema.Struct({ _tag: Schema.Literal("server.refreshProviders") });
    expect(
      Schema.decodeUnknownSync(legacyTaggedBody)({ _tag: "server.refreshProviders", force: false }),
    ).toEqual({ _tag: "server.refreshProviders" });
  });
});

describe("ServerProviderStatus", () => {
  it("promotes legacy provider-only snapshots to the default provider instance", () => {
    const parsed = decodeServerProviderStatus({
      provider: "codex",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.provider).toBe("codex");
    expect(parsed.driver).toBe("codex");
    expect(parsed.instanceId).toBe("codex");
  });

  it("preserves exact instance identity for same-driver provider snapshots", () => {
    const parsed = decodeServerProviderStatus({
      provider: "claudeAgent",
      driver: "claudeAgent",
      instanceId: "claude_work",
      displayName: "Claude Work",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      checkedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.provider).toBe("claudeAgent");
    expect(parsed.driver).toBe("claudeAgent");
    expect(parsed.instanceId).toBe("claude_work");
    expect(parsed.displayName).toBe("Claude Work");
  });
});
