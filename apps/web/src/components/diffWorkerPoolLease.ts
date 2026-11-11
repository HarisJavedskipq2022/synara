// FILE: diffWorkerPoolLease.ts
// Purpose: Lazy ownership of the shared @pierre/diffs worker pool. Constructing a
//          WorkerPoolManager starts every worker at once, so a surface creates the pool only
//          when a diff first needs it, and the pool is terminated once no committed surface
//          holds it.
// Layer: Diff rendering infrastructure
// Exports: createDiffWorkerPoolLease, DiffWorkerPoolLease, DiffWorkerPoolSetup,
//          DIFF_WORKER_POOL_ORPHAN_SWEEP_MS
// Depends on: @pierre/diffs/worker (the library's module-level pool singleton)
//
// Lifecycle of one owning surface (see DiffWorkerPoolProvider):
//   render              acquire()  hands out the current singleton, creating it if needed
//   insertion effect    hold()     counts the surface as a holder of every pool it handed out
//   insertion cleanup   unhold()   stops counting it
//   passive cleanup     release()  terminates the surface's pools that no surface holds
// React runs all insertion effects of a commit (cleanups and mounts) in the mutation phase,
// before any passive cleanup. When one surface unmounts in the same commit in which another
// acquires the pool and mounts, the newcomer already holds the pool when release() checks,
// so a handoff never terminates it. Holders are counted per pool, and release() terminates
// the surface's own pool references rather than whatever the singleton is by then, so a
// pool that stopped being the singleton is still terminated by the surfaces that used it.

import {
  getOrCreateWorkerPoolSingleton,
  terminateWorkerPoolSingleton,
  type SetupWorkerPoolProps,
  type WorkerPoolManager,
} from "@pierre/diffs/worker";

export type DiffWorkerPoolSetup = SetupWorkerPoolProps;

/**
 * How long a pool acquired by a surface that has not committed may stay unheld
 * before it is treated as left behind by a discarded render and terminated.
 */
export const DIFF_WORKER_POOL_ORPHAN_SWEEP_MS = 5_000;

// Committed surfaces holding each pool.
const holdersByPool = new Map<WorkerPoolManager, number>();
// The pool the library singleton currently is. Only this module creates or
// terminates the singleton, so this stays accurate.
let currentSingleton: WorkerPoolManager | undefined;

function holderCount(pool: WorkerPoolManager): number {
  return holdersByPool.get(pool) ?? 0;
}

function terminatePool(pool: WorkerPoolManager): void {
  holdersByPool.delete(pool);
  if (pool === currentSingleton) {
    currentSingleton = undefined;
    terminateWorkerPoolSingleton();
  } else {
    pool.terminate();
  }
}

/** One diff surface's claim on the shared pool. */
export interface DiffWorkerPoolLease {
  /**
   * The current shared pool, created on first use with `setup`. Undefined
   * outside a browser, as with the library provider.
   */
  acquire(setup: DiffWorkerPoolSetup): WorkerPoolManager | undefined;
  /** The pools this surface handed out and has not released; never creates one. */
  pools(): readonly WorkerPoolManager[];
  /** Insertion effect: the surface committed and holds its pools. */
  hold(): void;
  /** Insertion effect cleanup: the surface no longer holds its pools. */
  unhold(): void;
  /** Passive effect cleanup: terminate this surface's pools that no surface holds. */
  release(): void;
}

export function createDiffWorkerPoolLease(): DiffWorkerPoolLease {
  const ownPools = new Set<WorkerPoolManager>();
  const heldPools = new Set<WorkerPoolManager>();
  let holding = false;
  let everHeld = false;
  let sweepTimer: ReturnType<typeof setTimeout> | undefined;

  const holdPool = (pool: WorkerPoolManager) => {
    if (heldPools.has(pool)) return;
    heldPools.add(pool);
    holdersByPool.set(pool, holderCount(pool) + 1);
  };
  // A render React discards never runs hold(), so nothing would release what
  // it acquired. The swept pools stay in ownPools: should the surface commit
  // after all, it holds them (a terminated pool restarts on its next task) and
  // its release() terminates them again.
  const scheduleOrphanSweep = () => {
    if (sweepTimer !== undefined) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = undefined;
      if (everHeld) return;
      for (const pool of ownPools) {
        if (holderCount(pool) === 0) terminatePool(pool);
      }
    }, DIFF_WORKER_POOL_ORPHAN_SWEEP_MS);
  };

  return {
    acquire(setup) {
      if (typeof window === "undefined") return undefined;
      // Always the current singleton, so a terminated pool is never handed out again.
      const pool = getOrCreateWorkerPoolSingleton(setup);
      currentSingleton = pool;
      ownPools.add(pool);
      if (holding) holdPool(pool);
      else if (!everHeld) scheduleOrphanSweep();
      return pool;
    },
    pools: () => [...ownPools],
    hold() {
      holding = true;
      everHeld = true;
      for (const pool of ownPools) holdPool(pool);
    },
    unhold() {
      holding = false;
      for (const pool of heldPools) holdersByPool.set(pool, holderCount(pool) - 1);
      heldPools.clear();
    },
    release() {
      // Strict mode and hidden Activity trees disconnect passive effects
      // while the surface still holds its pools.
      if (holding) return;
      for (const pool of ownPools) {
        if (holderCount(pool) > 0) continue;
        ownPools.delete(pool);
        terminatePool(pool);
      }
    },
  };
}
