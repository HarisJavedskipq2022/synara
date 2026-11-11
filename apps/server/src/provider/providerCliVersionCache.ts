// FILE: providerCliVersionCache.ts
// Purpose: Reuses successful provider CLI `--version` output while the probed binary is unchanged.
// Layer: Server provider health
// Exports: CurrentProviderCliVersionCache, makeProviderCliVersionCache, withProviderCliVersionCache

import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { envPathKeyFor, resolveExecutable } from "@synara/shared/executable";
import { Clock, Effect, ServiceMap } from "effect";

import type { CommandResult } from "./providerCliOutput";

/**
 * Backstop for wrappers whose on-PATH file never changes while the real binary
 * is replaced (version-manager shims, launcher scripts that pick a versioned
 * install at run time). File identity catches symlinked installs, npm, Homebrew
 * and native installers; this expiry bounds staleness for everything else.
 */
export const PROVIDER_CLI_VERSION_CACHE_TTL_MS = 10 * 60_000;

interface ProviderCliVersionCacheEntry {
  readonly fingerprint: string;
  readonly storedAtMs: number;
  readonly result: CommandResult;
}

export interface ProviderCliVersionCache {
  readonly entries: Map<string, ProviderCliVersionCacheEntry>;
}

export function makeProviderCliVersionCache(): ProviderCliVersionCache {
  return { entries: new Map() };
}

export interface ProviderCliVersionCacheScope {
  readonly cache: ProviderCliVersionCache;
  /** Explicit refreshes re-run every version probe and store the fresh output. */
  readonly bypass: boolean;
}

/**
 * The cache a version probe may use. `null` (the default) runs every probe, so
 * direct health-check callers and tests keep spawning exactly as before; the
 * provider-health layer provides a cache around its refresh passes.
 */
export const CurrentProviderCliVersionCache =
  ServiceMap.Reference<ProviderCliVersionCacheScope | null>(
    "synara/provider/CurrentProviderCliVersionCache",
    { defaultValue: () => null },
  );

export interface ProviderCliCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string | undefined;
}

/** Version queries end in `--version`, including wrapped forms such as `cursor agent --version`. */
export function isProviderCliVersionCommand(args: ReadonlyArray<string>): boolean {
  return args.at(-1) === "--version";
}

async function fileIdentity(filePath: string): Promise<string | null> {
  try {
    const resolvedPath = await realpath(filePath);
    const stats = await stat(resolvedPath);
    // ctime changes whenever a file is written or replaced and cannot be set by
    // installers, which keep npm-style fixed mtimes; inode catches atomic swaps.
    return [resolvedPath, stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
  } catch {
    return null;
  }
}

/**
 * Identity of the files a version command would run: the executable resolved on
 * the command's PATH (symlinks followed to the real install) plus any absolute
 * path argument, such as a PowerShell script or a launcher's entry file. Null
 * when the executable cannot be found, so the probe runs and reports it.
 */
export async function fingerprintProviderCliCommand(
  input: ProviderCliCommand,
): Promise<string | null> {
  let executablePath: string | null;
  try {
    executablePath = resolveExecutable(input.command, {
      env: input.env,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    });
  } catch {
    return null;
  }
  if (executablePath === null) return null;
  const executableIdentity = await fileIdentity(executablePath);
  if (executableIdentity === null) return null;
  const argumentIdentities = await Promise.all(
    input.args
      .filter((arg) => isAbsolute(arg))
      .map(async (arg) => (await fileIdentity(arg)) ?? `missing:${arg}`),
  );
  return [executableIdentity, ...argumentIdentities].join("|");
}

function cacheKeyFor(input: ProviderCliCommand): string {
  return JSON.stringify([
    input.command,
    input.args,
    input.cwd ?? null,
    input.env[envPathKeyFor(input.env)] ?? null,
  ]);
}

/**
 * Runs `run` unless a cache scope holds successful output for the same version
 * command and the same binary identity within the expiry. Only exit-code-0
 * results are stored; failures, timeouts and non-zero exits always re-probe.
 */
export const withProviderCliVersionCache = <E, R>(
  input: ProviderCliCommand,
  run: Effect.Effect<CommandResult, E, R>,
): Effect.Effect<CommandResult, E, R> =>
  Effect.gen(function* () {
    const scope = yield* CurrentProviderCliVersionCache;
    if (scope === null || !isProviderCliVersionCommand(input.args)) {
      return yield* run;
    }
    const fingerprint = yield* Effect.promise(() => fingerprintProviderCliCommand(input));
    if (fingerprint === null) {
      return yield* run;
    }
    const key = cacheKeyFor(input);
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = scope.cache.entries.get(key);
    if (
      !scope.bypass &&
      cached !== undefined &&
      cached.fingerprint === fingerprint &&
      nowMs - cached.storedAtMs < PROVIDER_CLI_VERSION_CACHE_TTL_MS
    ) {
      return cached.result;
    }
    scope.cache.entries.delete(key);
    const result = yield* run;
    if (result.code === 0) {
      // The fingerprint was taken before the run, so a binary replaced mid-probe
      // mismatches on the next lookup and re-probes instead of pinning old output.
      scope.cache.entries.set(key, { fingerprint, storedAtMs: nowMs, result });
    }
    return result;
  });
