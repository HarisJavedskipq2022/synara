// FILE: backendNodeOptions.test.ts
// Purpose: Verifies desktop backend Node args preserve user-provided Node options
// and enable the compile cache only through the backend's own argv.
// Layer: Desktop startup tests

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import * as NodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  backendCompileCacheArgs,
  resolveBackendMaxOldSpaceMb,
  resolveBackendNodeArgs,
  withBackendHeapLimitArg,
} from "./backendNodeOptions";

const gb = (value: number) => value * 1024 * 1024 * 1024;

describe("resolveBackendMaxOldSpaceMb", () => {
  it("uses a valid explicit override", () => {
    expect(resolveBackendMaxOldSpaceMb({ configuredMb: "5120", totalMemoryBytes: gb(16) })).toBe(
      5120,
    );
  });

  it("clamps explicit overrides to bootable bounds", () => {
    expect(resolveBackendMaxOldSpaceMb({ configuredMb: "64", totalMemoryBytes: gb(16) })).toBe(
      1024,
    );
    expect(resolveBackendMaxOldSpaceMb({ configuredMb: "999999", totalMemoryBytes: gb(16) })).toBe(
      32768,
    );
  });

  it("ignores non-numeric overrides", () => {
    expect(resolveBackendMaxOldSpaceMb({ configuredMb: "lots", totalMemoryBytes: gb(24) })).toBe(
      6144,
    );
  });

  it("computes a bounded default from system memory", () => {
    expect(resolveBackendMaxOldSpaceMb({ totalMemoryBytes: gb(8) })).toBe(3072);
    expect(resolveBackendMaxOldSpaceMb({ totalMemoryBytes: gb(24) })).toBe(6144);
    expect(resolveBackendMaxOldSpaceMb({ totalMemoryBytes: gb(128) })).toBe(8192);
  });
});

describe("withBackendHeapLimitArg", () => {
  it("adds a heap limit when none exists", () => {
    expect(withBackendHeapLimitArg("--trace-warnings", 4096)).toEqual([
      "--max-old-space-size=4096",
    ]);
  });

  it("preserves an existing hyphenated heap limit", () => {
    expect(withBackendHeapLimitArg("--max-old-space-size=2048 --trace-warnings", 4096)).toEqual([]);
  });

  it("preserves an existing underscored heap limit", () => {
    expect(withBackendHeapLimitArg("--max_old_space_size=2048", 4096)).toEqual([]);
  });
});

describe("resolveBackendNodeArgs", () => {
  it("returns only the backend heap arg while leaving existing NODE_OPTIONS untouched", () => {
    expect(
      resolveBackendNodeArgs({
        existingNodeOptions: "--enable-source-maps",
        totalMemoryBytes: gb(24),
      }),
    ).toEqual(["--max-old-space-size=6144"]);
  });
});

// Node treats NODE_DISABLE_COMPILE_CACHE as set even when empty, so the
// child gets an environment without any compile-cache variables at all.
const childEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  delete env.NODE_COMPILE_CACHE;
  delete env.NODE_DISABLE_COMPILE_CACHE;
  delete env.NODE_OPTIONS;
  return env;
};

const runWithArgs = (args: string[]) =>
  spawnSync(
    process.execPath,
    [
      ...args,
      "--input-type=module",
      "-e",
      'import { getCompileCacheDir } from "node:module"; console.log(String(getCompileCacheDir()));',
    ],
    { encoding: "utf8", env: childEnv() },
  );

const waitUntil = async (condition: () => boolean, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const cacheEntries = (directory: string): string[] =>
  existsSync(directory)
    ? readdirSync(directory).flatMap((version) => readdirSync(join(directory, version)))
    : [];

// Runs the fixture until `ready` holds, then ends it with SIGTERM the way the
// desktop ends the backend, so Node never gets a normal exit to persist on.
const runUntilTerminated = async (
  args: string[],
  entry: string,
  ready: (stderr: string) => boolean,
  env: NodeJS.ProcessEnv = childEnv(),
): Promise<{ signal: NodeJS.Signals | null; stderr: string }> => {
  const child = spawn(process.execPath, [...args, entry], { env });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    child.once("exit", (_code, signal) => resolve(signal));
  });
  try {
    await waitUntil(() => ready(stderr), 10_000);
  } finally {
    child.kill("SIGTERM");
  }
  return { signal: await exited, stderr };
};

describe("backendCompileCacheArgs", () => {
  const temporaryDirectories: string[] = [];
  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("adds nothing without a cache directory", () => {
    expect(backendCompileCacheArgs(null)).toEqual([]);
    expect(backendCompileCacheArgs("")).toEqual([]);
  });

  it("passes the directory through a single argv preload, not the environment", () => {
    const directory = String.raw`/Users/someone/Library/Application Support/App "x"\cache`;
    const args = backendCompileCacheArgs(directory);
    expect(args).toHaveLength(1);
    const [flag, url] = args[0]!.split(/=(.*)/s);
    expect(flag).toBe("--import");
    expect(url?.startsWith("data:text/javascript,")).toBe(true);
    const source = decodeURIComponent(url!.slice("data:text/javascript,".length));
    expect(source).toContain(`enableCompileCache(${JSON.stringify(directory)})`);
  });

  it.skipIf(typeof NodeModule.enableCompileCache !== "function")(
    "enables the compile cache in a real Node child",
    () => {
      const root = mkdtempSync(join(tmpdir(), "synara-backend-compile-cache-"));
      temporaryDirectories.push(root);
      const directory = join(root, "not yet created");
      const result = runWithArgs(backendCompileCacheArgs(directory));
      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith(directory)).toBe(true);
      expect(readdirSync(directory)).toHaveLength(1);
    },
  );

  it.skipIf(typeof NodeModule.enableCompileCache !== "function")(
    "starts normally when the cache directory cannot be created",
    () => {
      const root = mkdtempSync(join(tmpdir(), "synara-backend-compile-cache-"));
      temporaryDirectories.push(root);
      const blocker = join(root, "file");
      // A file where the cache's parent directory should be: mkdir fails under it.
      writeFileSync(blocker, "");
      const result = runWithArgs(backendCompileCacheArgs(join(blocker, "cache")));
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim()).toBe("undefined");
    },
  );

  it("keeps the preload argument short", () => {
    const [arg] = backendCompileCacheArgs(join("/Users/someone", "x".repeat(200)));
    expect(arg!.length).toBeLessThan(2_048);
  });

  it.skipIf(typeof NodeModule.flushCompileCache !== "function")(
    "persists the cache before a SIGTERM, including later modules, and the next run uses it",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "synara-backend-compile-cache-"));
      temporaryDirectories.push(root);
      writeFileSync(join(root, "early.mjs"), "export const early = [1].map((x) => x);\n");
      writeFileSync(join(root, "late.mjs"), "export const late = [2].map((x) => x);\n");
      // Loads one module at startup and one after the first flush, and never
      // exits by itself, like the backend.
      writeFileSync(
        join(root, "main.mjs"),
        'import "./early.mjs";\nsetTimeout(() => import("./late.mjs"), 200);\nsetInterval(() => {}, 1_000);\n',
      );
      const cache = join(root, "cache");
      const args = backendCompileCacheArgs(cache, [100, 400]);

      const first = await runUntilTerminated(
        args,
        join(root, "main.mjs"),
        () => cacheEntries(cache).length >= 3,
      );
      expect(first.signal).toBe("SIGTERM");
      expect(cacheEntries(cache)).toHaveLength(3);

      const second = await runUntilTerminated(
        args,
        join(root, "main.mjs"),
        (stderr) => /late\.mjs was accepted/.test(stderr),
        { ...childEnv(), NODE_DEBUG_NATIVE: "COMPILE_CACHE" },
      );
      expect(second.signal).toBe("SIGTERM");
      for (const name of ["main.mjs", "early.mjs", "late.mjs"]) {
        expect(second.stderr).toContain(`${name} was accepted`);
      }
    },
  );

  it.skipIf(typeof NodeModule.enableCompileCache !== "function")(
    "leaves the cache off when the user sets NODE_DISABLE_COMPILE_CACHE",
    () => {
      const root = mkdtempSync(join(tmpdir(), "synara-backend-compile-cache-"));
      temporaryDirectories.push(root);
      const directory = join(root, "cache");
      const result = spawnSync(
        process.execPath,
        [
          ...backendCompileCacheArgs(directory, [0]),
          "--input-type=module",
          "-e",
          'import { getCompileCacheDir } from "node:module"; console.log(String(getCompileCacheDir()));',
        ],
        { encoding: "utf8", env: { ...childEnv(), NODE_DISABLE_COMPILE_CACHE: "1" } },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("undefined");
      expect(existsSync(directory)).toBe(false);
    },
  );
});
