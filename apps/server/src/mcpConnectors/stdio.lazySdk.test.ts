// FILE: stdio.lazySdk.test.ts
// Purpose: Verifies local connectors keep the MCP SDK off the server's import path until a
//   local connector is used, and report a broken SDK install as an unavailable connector.
// Layer: Connectors runtime tests
// Depends on: StdioConnectorSessions and McpConnectorRuntime.

import { expect, it, vi } from "vitest";

// Each factory runs when source code first imports that module, so the set
// records which MCP SDK entry points have been loaded so far.
const loaded = vi.hoisted(() => new Set<string>());
vi.mock("@modelcontextprotocol/sdk/client/index.js", async (importOriginal) => {
  loaded.add("client/index.js");
  return importOriginal();
});
vi.mock("@modelcontextprotocol/sdk/types.js", async (importOriginal) => {
  loaded.add("types.js");
  return importOriginal();
});

// Refuses initialize and stays up until stdin closes, so the probe ends as a
// server that did not initialize and teardown can still prove the exit.
const refusingServer = {
  transport: "stdio" as const,
  command: process.execPath,
  args: [
    "-e",
    `process.stdin.on("data", (chunk) => {
      const message = JSON.parse(String(chunk).split("\\n")[0]);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "refused" } }) + "\\n");
    });
    process.stdin.on("end", () => process.exit(0));`,
  ],
  env: {},
};

it("loads the MCP SDK on the first local connector, not with the connector runtime", async () => {
  const { McpConnectorRuntime } = await import("./runtime.ts");
  const { StdioConnectorSessions } = await import("./stdio.ts");
  const runtime = new McpConnectorRuntime({
    load: async () => null,
    save: async () => {},
    publish: () => {},
    redirectUrl: () => "http://127.0.0.1/oauth/mcp/callback",
    clientVersion: "1",
    logWarning: () => {},
  });
  await runtime.init();
  await runtime.refreshLocalStatus();
  expect([...loaded]).toEqual([]);

  const sessions = new StdioConnectorSessions(
    () => false,
    async () => {},
  );
  await expect(sessions.probe(refusingServer)).resolves.toBe(false);
  expect([...loaded]).toEqual(expect.arrayContaining(["client/index.js", "types.js"]));
  await sessions.dispose();
  await runtime.dispose();
});

it("reports a connector whose MCP SDK fails to load as unavailable", async () => {
  vi.resetModules();
  vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => {
    throw new Error("broken install");
  });
  const { StdioConnectorSessions } = await import("./stdio.ts");
  const sessions = new StdioConnectorSessions(
    (token) => token === "owner",
    async () => {},
  );
  await expect(sessions.probe(refusingServer)).resolves.toBe(false);
  await expect(
    sessions.forward("connector", refusingServer, {
      method: "POST",
      ownerToken: "owner",
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    }),
  ).rejects.toThrow("The MCP SDK could not be loaded.");
  await sessions.dispose();
  vi.doUnmock("@modelcontextprotocol/sdk/client/index.js");
});
