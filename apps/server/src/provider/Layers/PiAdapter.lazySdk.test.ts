// FILE: PiAdapter.lazySdk.test.ts
// Purpose: Verifies the Pi adapter keeps pi-ai off the server's import path until Pi is used.
// Layer: Provider adapter tests
// Depends on: PiAdapter model runtime helpers and the OpenCode catalog refresh.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";

// Each factory runs when source code first imports that module, so the set
// records which pi-ai entry points have been loaded so far.
const loaded = vi.hoisted(() => new Set<string>());
vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
  loaded.add("compat");
  return importOriginal();
});
vi.mock("@earendil-works/pi-ai/providers/azure", async (importOriginal) => {
  loaded.add("providers/azure");
  return importOriginal();
});
vi.mock("@earendil-works/pi-ai/providers/openrouter", async (importOriginal) => {
  loaded.add("providers/openrouter");
  return importOriginal();
});
vi.mock("@earendil-works/pi-ai/providers/opencode", async (importOriginal) => {
  loaded.add("providers/opencode");
  return importOriginal();
});
vi.mock("@earendil-works/pi-ai/utils/model-operations", async (importOriginal) => {
  loaded.add("utils/model-operations");
  return importOriginal();
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("loads pi-ai on the first Pi model runtime, not when the adapter module loads", async () => {
  const { createPiModelRuntime } = await import("./PiAdapter.ts");
  const { refreshPiOpenCodeCatalog } = await import("../piOpenCodeCatalog.ts");
  expect([...loaded]).toEqual([]);

  const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-lazy-sdk-"));
  dirs.push(agentDir);
  const piSdk = await import("@earendil-works/pi-coding-agent");
  await createPiModelRuntime(agentDir, piSdk, undefined, undefined, undefined, {
    stateDir: path.join(agentDir, "state"),
    homeDir: agentDir,
  });
  expect([...loaded]).toEqual(
    expect.arrayContaining([
      "compat",
      "providers/azure",
      "providers/openrouter",
      "utils/model-operations",
    ]),
  );

  // The OpenCode catalog loads its provider only once auth makes it relevant.
  const runtime = {
    hasConfiguredAuth: () => true,
    getModels: () => [],
  } as unknown as ModelRuntime;
  await refreshPiOpenCodeCatalog(runtime, {
    environment: {},
    request: async () => {
      throw new Error("offline test catalog");
    },
  });
  expect(loaded.has("providers/opencode")).toBe(true);
});
