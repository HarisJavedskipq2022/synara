import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@synara/contracts";

import { makeAgentGatewaySessionRegistry } from "./AgentGatewaySessionRegistry.ts";

const sorted = (capabilities: ReadonlySet<string> | undefined) =>
  [...(capabilities ?? [])].toSorted();

describe("AgentGatewaySessionRegistry", () => {
  it("permanently revokes old computer credentials through re-enable", () => {
    const registry = makeAgentGatewaySessionRegistry();
    const thread = ThreadId.makeUnsafe("thread-1");
    const old = registry.issue(thread, "codex", { additionalCapabilities: ["computer:control"] });
    registry.setComputerControlEnabled?.(thread, false);
    assert.isFalse(registry.verify(old.token)?.capabilities.has("computer:control"));
    assert.isFalse(registry.computerControlProvisioned?.(thread, "codex"));
    registry.setComputerControlEnabled?.(thread, true);
    assert.isFalse(registry.verify(old.token)?.capabilities.has("computer:control"));
    const fresh = registry.issue(thread, "codex", { additionalCapabilities: ["computer:control"] });
    assert.isTrue(registry.verify(fresh.token)?.capabilities.has("computer:control"));
    assert.isTrue(registry.computerControlProvisioned?.(thread, "codex"));
    assert.isFalse(registry.computerControlProvisioned?.(thread, "claudeAgent"));
    registry.issue(thread, "codex");
    assert.isFalse(registry.computerControlProvisioned?.(thread, "codex"));
  });
  it("allows independent legitimate sessions for the same thread", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const first = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const second = registry.issue(ThreadId.makeUnsafe("thread-1"), "claudeAgent");
    assert.notEqual(first.token, second.token);
    assert.equal(registry.verify(first.token)?.threadId, "thread-1");
    assert.equal(registry.verify(second.token)?.threadId, "thread-1");
    assert.equal(registry.verify(first.token)?.provider, "codex");
    assert.equal(registry.verify(second.token)?.provider, "claudeAgent");
  });

  it("keeps replacement runtime credentials independent from outgoing-session revocation", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const first = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const second = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    assert.notEqual(first.token, second.token);
    assert.equal(registry.verify(first.token)?.threadId, "thread-1");
    assert.equal(registry.verify(second.token)?.threadId, "thread-1");

    registry.revoke(first.token);
    assert.isNull(registry.verify(first.token));
    assert.equal(registry.verify(second.token)?.threadId, "thread-1");
  });

  it("binds write authority to one exact turn and invalidates it on revocation", () => {
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => "authority" });
    const issued = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const authority = registry.bindWriteAuthority(issued.token, "turn-a");

    assert.isNotNull(authority);
    assert.equal(authority?.turnId, "turn-a");
    assert.isTrue(registry.verifyWriteAuthority(authority!));

    registry.revoke(issued.token);
    assert.isFalse(registry.verifyWriteAuthority(authority!));
    assert.isNull(registry.bindWriteAuthority(issued.token, "turn-b"));
  });

  it("permanently fences a terminal turn credential even when A never used it", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const outgoing = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");

    assert.isTrue(registry.retireWriteAuthority(outgoing.token, "turn-a"));
    assert.isNull(registry.bindWriteAuthority(outgoing.token, "turn-a"));
    assert.isNull(registry.bindWriteAuthority(outgoing.token, "turn-b"));
    // Retirement is idempotent for the same terminal turn but cannot be
    // reassigned to a different one.
    assert.isTrue(registry.retireWriteAuthority(outgoing.token, "turn-a"));
    assert.isFalse(registry.retireWriteAuthority(outgoing.token, "turn-b"));

    const replacement = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const turnBAuthority = registry.bindWriteAuthority(replacement.token, "turn-b");
    assert.isNotNull(turnBAuthority);
    assert.isTrue(registry.verifyWriteAuthority(turnBAuthority!));
  });

  it("lists retired write authorities per thread until the credential is revoked", () => {
    let nextId = 0;
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => String(++nextId) });
    const thread = ThreadId.makeUnsafe("thread-1");
    const issued = registry.issue(thread, "codex");
    const otherThread = registry.issue(ThreadId.makeUnsafe("thread-2"), "codex");

    assert.deepEqual(registry.listRetiredWriteAuthorities(thread), []);

    registry.retireWriteAuthority(issued.token, "turn-a");
    registry.retireWriteAuthority(otherThread.token, "turn-x");

    const retired = registry.listRetiredWriteAuthorities(thread);
    assert.equal(retired.length, 1);
    assert.equal(retired[0]?.sessionKey, issued.sessionKey);
    assert.equal(retired[0]?.provider, "codex");
    assert.equal(retired[0]?.retiredTurnId, "turn-a");
    assert.notInclude(JSON.stringify(retired), issued.token);

    registry.revoke(issued.token);
    assert.deepEqual(registry.listRetiredWriteAuthorities(thread), []);
    assert.equal(registry.listRetiredWriteAuthorities("thread-2").length, 1);
  });

  it("keeps credentials valid for a long-lived provider session but not across restart", () => {
    let time = 1_000;
    const firstRegistry = makeAgentGatewaySessionRegistry({
      now: () => time,
      randomId: () => "first",
    });
    const issued = firstRegistry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    time += 48 * 60 * 60 * 1_000;
    assert.equal(firstRegistry.verify(issued.token)?.threadId, "thread-1");

    const afterRestart = makeAgentGatewaySessionRegistry({ randomId: () => "second" });
    assert.isNull(afterRestart.verify(issued.token));
  });

  it("keeps raw bearer tokens out of verified session identity snapshots", () => {
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => "opaque-secret" });
    const issued = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const verified = registry.verify(issued.token);
    assert.match(issued.token, /^sagw_session_/);
    assert.notProperty(verified, "token");
    assert.notInclude(JSON.stringify(verified), issued.token);
  });

  it("keeps computer control opt-in instead of adding it to provider defaults", () => {
    const registry = makeAgentGatewaySessionRegistry({ randomId: () => "computer" });
    const ordinary = registry.issue(ThreadId.makeUnsafe("thread-1"), "codex");
    const optedIn = registry.issue(ThreadId.makeUnsafe("thread-2"), "codex", {
      additionalCapabilities: ["computer:control"],
    });

    assert.isFalse(ordinary.capabilities.has("computer:control"));
    assert.isTrue(optedIn.capabilities.has("computer:control"));
  });

  describe("Helix role profiles", () => {
    const BASE = [
      "automation:write",
      "browser:control",
      "device:control",
      "diagnostics:read",
      "thread:read",
      "thread:write",
    ];

    it("leaves a thread without a profile exactly as before", () => {
      const registry = makeAgentGatewaySessionRegistry();
      const thread = ThreadId.makeUnsafe("ordinary");
      const issued = registry.issue(thread, "codex");
      assert.deepStrictEqual(sorted(issued.capabilities), BASE);
      assert.deepStrictEqual(sorted(registry.verify(issued.token)?.capabilities), BASE);
      assert.isUndefined(registry.verify(issued.token)?.roleProfile);
      assert.isNull(registry.getThreadRoleProfile(thread));
    });

    it("without a profile: no profile key anywhere and computer control as before", () => {
      const registry = makeAgentGatewaySessionRegistry();
      const ordinary = registry.issue(ThreadId.makeUnsafe("plain"), "codex");
      const optedIn = registry.issue(ThreadId.makeUnsafe("computer"), "codex", {
        additionalCapabilities: ["computer:control"],
      });
      for (const issued of [ordinary, optedIn]) {
        assert.notProperty(issued, "roleProfile");
        assert.notProperty(registry.verify(issued.token) ?? {}, "roleProfile");
      }
      assert.isFalse(registry.computerControlProvisioned?.(ThreadId.makeUnsafe("plain"), "codex"));
      assert.isTrue(
        registry.computerControlProvisioned?.(ThreadId.makeUnsafe("computer"), "codex"),
      );
      // Clearing a profile that was never set changes nothing.
      registry.setThreadRoleProfile(ThreadId.makeUnsafe("plain"), null);
      assert.deepStrictEqual(sorted(registry.verify(ordinary.token)?.capabilities), BASE);
      assert.notProperty(registry.verify(ordinary.token) ?? {}, "roleProfile");
    });

    it("gives a Builder exactly helix:builder, dropping base and requested capabilities", () => {
      const registry = makeAgentGatewaySessionRegistry();
      const thread = ThreadId.makeUnsafe("builder");
      registry.setThreadRoleProfile(thread, { kind: "helix_builder", pairId: "pair-1" });
      const issued = registry.issue(thread, "codex", {
        additionalCapabilities: ["computer:control"],
      });
      assert.deepStrictEqual(sorted(issued.capabilities), ["helix:builder"]);
      const verified = registry.verify(issued.token);
      assert.deepStrictEqual(sorted(verified?.capabilities), ["helix:builder"]);
      assert.deepStrictEqual(verified?.roleProfile, { kind: "helix_builder", pairId: "pair-1" });
      assert.isFalse(registry.computerControlProvisioned?.(thread, "codex"));
      // Write authority still binds to the exact turn; only the capability set changes.
      assert.isNotNull(registry.bindWriteAuthority(issued.token, "turn-1"));
    });

    it("gives a Lead its normal capabilities plus helix:lead", () => {
      const registry = makeAgentGatewaySessionRegistry();
      const thread = ThreadId.makeUnsafe("lead");
      registry.setThreadRoleProfile(thread, { kind: "helix_lead", pairId: "pair-1" });
      const issued = registry.issue(thread, "claudeAgent", {
        additionalCapabilities: ["computer:control"],
      });
      assert.deepStrictEqual(
        sorted(registry.verify(issued.token)?.capabilities),
        [...BASE, "computer:control", "helix:lead"].toSorted(),
      );
    });

    it("applies to credentials issued before the profile, and clearing restores them", () => {
      const registry = makeAgentGatewaySessionRegistry();
      const thread = ThreadId.makeUnsafe("late");
      const issued = registry.issue(thread, "codex");
      registry.setThreadRoleProfile(thread, { kind: "helix_builder", pairId: "pair-1" });
      assert.deepStrictEqual(sorted(registry.verify(issued.token)?.capabilities), [
        "helix:builder",
      ]);
      registry.setThreadRoleProfile(thread, null);
      assert.deepStrictEqual(sorted(registry.verify(issued.token)?.capabilities), BASE);
    });

    it("a retired Builder keeps no capabilities on credentials issued before or after", () => {
      const registry = makeAgentGatewaySessionRegistry();
      const thread = ThreadId.makeUnsafe("retired");
      registry.setThreadRoleProfile(thread, { kind: "helix_builder", pairId: "pair-1" });
      const live = registry.issue(thread, "codex", {
        additionalCapabilities: ["computer:control"],
      });
      registry.setThreadRoleProfile(thread, { kind: "helix_retired", pairId: "pair-1" });
      assert.deepStrictEqual(sorted(registry.verify(live.token)?.capabilities), []);
      const later = registry.issue(thread, "codex");
      assert.deepStrictEqual(sorted(registry.verify(later.token)?.capabilities), []);
      assert.isFalse(registry.computerControlProvisioned?.(thread, "codex"));
    });

    it("never leaks a profile to another thread", () => {
      const registry = makeAgentGatewaySessionRegistry();
      registry.setThreadRoleProfile(ThreadId.makeUnsafe("builder"), {
        kind: "helix_builder",
        pairId: "pair-1",
      });
      const other = registry.issue(ThreadId.makeUnsafe("other"), "codex");
      assert.deepStrictEqual(sorted(registry.verify(other.token)?.capabilities), BASE);
    });
  });
});
