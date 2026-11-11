import {
  chmodSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as OS from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach } from "vitest";

import type { CommandResult } from "./providerCliOutput";
import {
  CurrentProviderCliVersionCache,
  makeProviderCliVersionCache,
  PROVIDER_CLI_VERSION_CACHE_TTL_MS,
  type ProviderCliVersionCache,
  withProviderCliVersionCache,
} from "./providerCliVersionCache";

// No CLI is ever spawned here: `run` is a counting stand-in for the process.
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(OS.tmpdir(), "provider-cli-version-cache-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeExecutable(name: string, content: string): string {
  const filePath = join(tempDir, name);
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
  return filePath;
}

function countingRun(result: CommandResult) {
  const counter = { calls: 0 };
  const run = Effect.sync(() => {
    counter.calls += 1;
    return result;
  });
  return { counter, run };
}

const ok: CommandResult = { stdout: "tool 1.2.3\n", stderr: "", code: 0 };

function probe(
  cache: ProviderCliVersionCache,
  command: string,
  run: Effect.Effect<CommandResult, unknown>,
  options?: { readonly bypass?: boolean; readonly args?: ReadonlyArray<string> },
) {
  return withProviderCliVersionCache(
    { command, args: options?.args ?? ["--version"], env: { PATH: tempDir } },
    run,
  ).pipe(
    Effect.provideService(CurrentProviderCliVersionCache, {
      cache,
      bypass: options?.bypass ?? false,
    }),
  );
}

describe("withProviderCliVersionCache", () => {
  it.effect("reuses a successful version probe while the binary is unchanged", () =>
    Effect.gen(function* () {
      const binary = writeExecutable("tool", "#!/bin/sh\necho 1\n");
      const cache = makeProviderCliVersionCache();
      const { counter, run } = countingRun(ok);

      const first = yield* probe(cache, binary, run);
      const second = yield* probe(cache, binary, run);
      // Bare names resolve on the command's PATH to the same binary entry.
      const viaPath = yield* probe(cache, "tool", run);

      assert.deepStrictEqual(first, ok);
      assert.deepStrictEqual(second, ok);
      assert.deepStrictEqual(viaPath, ok);
      // The bare name is a different cache key, so it probes once itself.
      assert.strictEqual(counter.calls, 2);
    }),
  );

  it.effect("re-probes when the binary is rewritten, swapped or re-pointed", () =>
    Effect.gen(function* () {
      const binary = writeExecutable("tool", "#!/bin/sh\necho 1\n");
      const cache = makeProviderCliVersionCache();
      const { counter, run } = countingRun(ok);

      yield* probe(cache, binary, run);
      writeFileSync(binary, "#!/bin/sh\necho 1.2.4-longer\n");
      yield* probe(cache, binary, run);
      assert.strictEqual(counter.calls, 2);

      // Same size, new inode: an installer's atomic rename over the old file.
      const replacement = writeExecutable("tool.next", "#!/bin/sh\necho 1.2.4-longer\n");
      renameSync(replacement, binary);
      yield* probe(cache, binary, run);
      assert.strictEqual(counter.calls, 3);

      // A symlinked install (Homebrew, native installers) is followed to its target.
      const v1 = writeExecutable("tool-v1", "#!/bin/sh\necho v1\n");
      const v2 = writeExecutable("tool-v2", "#!/bin/sh\necho v2\n");
      const link = join(tempDir, "tool-link");
      symlinkSync(v1, link);
      yield* probe(cache, link, run);
      yield* probe(cache, link, run);
      assert.strictEqual(counter.calls, 4);
      unlinkSync(link);
      symlinkSync(v2, link);
      yield* probe(cache, link, run);
      assert.strictEqual(counter.calls, 5);
    }),
  );

  it.effect("never caches non-zero exits or failed probes", () =>
    Effect.gen(function* () {
      const binary = writeExecutable("tool", "#!/bin/sh\nexit 1\n");
      const cache = makeProviderCliVersionCache();
      const nonzero = countingRun({ stdout: "", stderr: "boom", code: 1 });

      yield* probe(cache, binary, nonzero.run);
      yield* probe(cache, binary, nonzero.run);
      assert.strictEqual(nonzero.counter.calls, 2);

      let failures = 0;
      const failing = Effect.suspend(() => {
        failures += 1;
        return Effect.fail(new Error("spawn failed"));
      });
      yield* Effect.flip(probe(cache, binary, failing));
      yield* Effect.flip(probe(cache, binary, failing));
      assert.strictEqual(failures, 2);

      // A later success after failures is cached normally.
      const success = countingRun(ok);
      yield* probe(cache, binary, success.run);
      yield* probe(cache, binary, success.run);
      assert.strictEqual(success.counter.calls, 1);
    }),
  );

  it.effect("drops an unchanged binary's output once the expiry passes", () =>
    Effect.gen(function* () {
      const binary = writeExecutable("tool", "#!/bin/sh\necho 1\n");
      const cache = makeProviderCliVersionCache();
      const { counter, run } = countingRun(ok);

      yield* probe(cache, binary, run);
      yield* TestClock.adjust(Duration.millis(PROVIDER_CLI_VERSION_CACHE_TTL_MS - 1));
      yield* probe(cache, binary, run);
      assert.strictEqual(counter.calls, 1);
      yield* TestClock.adjust(Duration.millis(1));
      yield* probe(cache, binary, run);
      assert.strictEqual(counter.calls, 2);
    }),
  );

  it.effect("re-probes on a bypassing (forced) pass and stores the fresh output", () =>
    Effect.gen(function* () {
      const binary = writeExecutable("tool", "#!/bin/sh\necho 1\n");
      const cache = makeProviderCliVersionCache();
      const stale = countingRun(ok);
      const fresh = countingRun({ stdout: "tool 9.9.9\n", stderr: "", code: 0 });

      yield* probe(cache, binary, stale.run);
      const forced = yield* probe(cache, binary, fresh.run, { bypass: true });
      const reused = yield* probe(cache, binary, stale.run);

      assert.strictEqual(forced.stdout, "tool 9.9.9\n");
      assert.strictEqual(reused.stdout, "tool 9.9.9\n");
      assert.strictEqual(stale.counter.calls, 1);
      assert.strictEqual(fresh.counter.calls, 1);
    }),
  );

  it.effect(
    "runs every probe without a cache scope, for other commands, or when unresolvable",
    () =>
      Effect.gen(function* () {
        const binary = writeExecutable("tool", "#!/bin/sh\necho 1\n");
        const cache = makeProviderCliVersionCache();
        const { counter, run } = countingRun(ok);

        const unscoped = withProviderCliVersionCache(
          { command: binary, args: ["--version"], env: { PATH: tempDir } },
          run,
        );
        yield* unscoped;
        yield* unscoped;
        assert.strictEqual(counter.calls, 2);

        yield* probe(cache, binary, run, { args: ["auth", "status"] });
        yield* probe(cache, binary, run, { args: ["auth", "status"] });
        assert.strictEqual(counter.calls, 4);

        yield* probe(cache, "missing-tool", run);
        yield* probe(cache, "missing-tool", run);
        assert.strictEqual(counter.calls, 6);
      }),
  );
});
