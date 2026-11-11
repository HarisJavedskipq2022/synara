// FILE: DiffWorkerPoolProvider.tsx
// Purpose: Gives a diff surface the shared @pierre/diffs worker pool without starting it.
//          The pool (2-6 workers, each loading the worker script and a highlighter) is created
//          when the first diff renders, or when idle while a diff panel is on screen.
// Layer: Diff rendering infrastructure
// Exports: DiffWorkerPoolProvider, DiffWorkerPoolScope
// Depends on: diffWorkerPoolLease, @pierre/diffs WorkerPoolContext

import { WorkerPoolContext } from "@pierre/diffs/react";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import {
  createContext,
  useContext,
  useEffect,
  useInsertionEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTheme } from "../hooks/useTheme";
import { resolveDiffThemeName } from "../lib/diffRendering";
import {
  createDiffWorkerPoolLease,
  type DiffWorkerPoolLease,
  type DiffWorkerPoolSetup,
} from "./diffWorkerPoolLease";

interface LazyDiffWorkerPool {
  readonly lease: DiffWorkerPoolLease;
  readonly setup: DiffWorkerPoolSetup;
}

const LazyDiffWorkerPoolContext = createContext<LazyDiffWorkerPool | null>(null);

const createDiffsWorker = () => new DiffsWorker();

// Run `callback` in an idle slot (setTimeout where requestIdleCallback is
// missing); returns a cancel.
function runWhenIdle(callback: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(callback, { timeout: 1_000 });
    return () => cancelIdleCallback(id);
  }
  const id = setTimeout(callback, 200);
  return () => clearTimeout(id);
}

export function DiffWorkerPoolProvider({
  children,
  warmWhenIdle,
}: {
  children?: ReactNode;
  /** Create the pool after first paint, before any diff asks for it (a diff panel is on screen). */
  warmWhenIdle?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const cores =
    typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
  const workerPoolSize = Math.max(2, Math.min(6, Math.floor(cores / 2)));
  const [lease] = useState(createDiffWorkerPoolLease);
  const lazyPool = useMemo<LazyDiffWorkerPool>(
    () => ({
      lease,
      setup: {
        poolOptions: {
          workerFactory: createDiffsWorker,
          poolSize: workerPoolSize,
          totalASTLRUCacheSize: 240,
        },
        highlighterOptions: {
          theme: diffThemeName,
          tokenizeMaxLineLength: 1_000,
        },
      },
    }),
    [lease, workerPoolSize, diffThemeName],
  );

  // Holding is counted in insertion effects, which React runs for the whole
  // commit before any passive cleanup, and the zero check is a passive cleanup:
  // a surface unmounting in the same commit in which another one's first diff
  // renders hands the pool over instead of terminating it (diffWorkerPoolLease).
  useInsertionEffect(() => {
    lease.hold();
    return () => lease.unhold();
  }, [lease]);
  useEffect(() => () => lease.release(), [lease]);

  // A pool is created with the theme of its first render; follow later changes.
  useEffect(() => {
    for (const workerPool of lease.pools()) {
      const current = workerPool.getDiffRenderOptions();
      if (current.theme === diffThemeName) {
        continue;
      }

      void workerPool
        .setRenderOptions({
          ...current,
          theme: diffThemeName,
        })
        .catch(() => undefined);
    }
  }, [lease, diffThemeName]);

  const shouldWarm = warmWhenIdle ?? false;
  useEffect(() => {
    if (!shouldWarm) {
      return;
    }
    return runWhenIdle(() => {
      lazyPool.lease.acquire(lazyPool.setup);
    });
  }, [shouldWarm, lazyPool]);

  return (
    <LazyDiffWorkerPoolContext.Provider value={lazyPool}>
      {children}
    </LazyDiffWorkerPoolContext.Provider>
  );
}

/**
 * Wrap each @pierre/diffs component that should render through the worker
 * pool. The first scope to render under a DiffWorkerPoolProvider creates the
 * shared pool; outside a provider the diff renders without workers, as before.
 */
export function DiffWorkerPoolScope({ children }: { children: ReactNode }) {
  const lazyPool = useContext(LazyDiffWorkerPoolContext);
  // Synchronous so the diff instance, which reads the pool once when it is
  // created, gets it on its first render.
  const [workerPool] = useState(() => lazyPool?.lease.acquire(lazyPool.setup));
  if (lazyPool === null) {
    return children;
  }
  return <WorkerPoolContext.Provider value={workerPool}>{children}</WorkerPoolContext.Provider>;
}
