import { WorkerPoolContext } from "@pierre/diffs/react";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import { act, StrictMode, Suspense, use, useContext, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workerLog = vi.hoisted(() => ({ constructed: 0, terminated: 0 }));

// Stands in for the 834 KB worker script; counting constructions shows when workers start.
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({
  default: class FakeDiffsWorker {
    constructor() {
      workerLog.constructed += 1;
    }
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    terminate() {
      workerLog.terminated += 1;
    }
  },
}));

vi.mock("@pierre/diffs/worker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pierre/diffs/worker")>();
  return {
    ...actual,
    getOrCreateWorkerPoolSingleton: vi.fn(actual.getOrCreateWorkerPoolSingleton),
    terminateWorkerPoolSingleton: vi.fn(actual.terminateWorkerPoolSingleton),
  };
});

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

const { getOrCreateWorkerPoolSingleton, terminateWorkerPoolSingleton } =
  await import("@pierre/diffs/worker");
const { DiffWorkerPoolProvider, DiffWorkerPoolScope } = await import("./DiffWorkerPoolProvider");
const { createDiffWorkerPoolLease, DIFF_WORKER_POOL_ORPHAN_SWEEP_MS } =
  await import("./diffWorkerPoolLease");
const { resolveDiffThemeName } = await import("../lib/diffRendering");
const { createHostlessRoot } = await import("./hostlessReactRoot.test-support");

const POOL_SETUP = {
  poolOptions: {
    workerFactory: () => {
      workerLog.constructed += 1;
      return {
        addEventListener() {},
        removeEventListener() {},
        postMessage() {},
        terminate() {
          workerLog.terminated += 1;
        },
      } as unknown as Worker;
    },
    poolSize: 3,
  },
  highlighterOptions: { theme: "pierre-light" as const },
};

function PoolProbe(props: { seen: Array<WorkerPoolManager | undefined> }) {
  props.seen.push(useContext(WorkerPoolContext));
  return <span>diff</span>;
}

// The pool schedules state broadcasts with animation frames, including after a test ends.
Object.assign(globalThis, {
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});

beforeEach(() => {
  // The pool is browser-only, like the library provider it replaces.
  vi.stubGlobal("window", globalThis);
  workerLog.constructed = 0;
  workerLog.terminated = 0;
  vi.mocked(getOrCreateWorkerPoolSingleton).mockClear();
  vi.mocked(terminateWorkerPoolSingleton).mockClear();
});

afterEach(() => {
  // Server renders never unmount, so drop any pool they created.
  terminateWorkerPoolSingleton();
  vi.unstubAllGlobals();
});

describe("DiffWorkerPoolProvider", () => {
  it("creates no pool and no worker when nothing under it renders a diff", async () => {
    const markup = renderToStaticMarkup(
      <DiffWorkerPoolProvider>
        <p>thread without diffs</p>
      </DiffWorkerPoolProvider>,
    );

    expect(markup).toBe("<p>thread without diffs</p>");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getOrCreateWorkerPoolSingleton).not.toHaveBeenCalled();
    expect(workerLog.constructed).toBe(0);
  });

  it("creates the pool once, on the first diff, and shares it between diffs", () => {
    const seen: Array<WorkerPoolManager | undefined> = [];
    renderToStaticMarkup(
      <DiffWorkerPoolProvider>
        <DiffWorkerPoolScope>
          <PoolProbe seen={seen} />
        </DiffWorkerPoolScope>
        <DiffWorkerPoolScope>
          <PoolProbe seen={seen} />
        </DiffWorkerPoolScope>
      </DiffWorkerPoolProvider>,
    );

    expect(distinctPools()).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBe(seen[0]);
  });

  it("keeps the existing pool size and options", async () => {
    renderToStaticMarkup(
      <DiffWorkerPoolProvider>
        <DiffWorkerPoolScope>
          <span />
        </DiffWorkerPoolScope>
      </DiffWorkerPoolProvider>,
    );

    const [setup] = vi.mocked(getOrCreateWorkerPoolSingleton).mock.calls[0]!;
    expect(setup.poolOptions.totalASTLRUCacheSize).toBe(240);
    expect(setup.poolOptions.poolSize).toBeGreaterThanOrEqual(2);
    expect(setup.poolOptions.poolSize).toBeLessThanOrEqual(6);
    expect(setup.highlighterOptions).toEqual({
      theme: resolveDiffThemeName("light"),
      tokenizeMaxLineLength: 1_000,
    });
    // The first diff starts the whole pool, through the bundled worker script.
    await vi.waitFor(() => expect(workerLog.constructed).toBe(setup.poolOptions.poolSize), {
      timeout: 20_000,
    });
  });

  it("leaves a diff outside any provider without a pool, as before", () => {
    const seen: Array<WorkerPoolManager | undefined> = [];
    renderToStaticMarkup(
      <DiffWorkerPoolScope>
        <PoolProbe seen={seen} />
      </DiffWorkerPoolScope>,
    );

    expect(seen).toEqual([undefined]);
    expect(getOrCreateWorkerPoolSingleton).not.toHaveBeenCalled();
  });
});

type SeenPools = Array<WorkerPoolManager | undefined>;

function HostlessPoolProbe(props: { seen: SeenPools }) {
  props.seen.push(useContext(WorkerPoolContext));
  return null;
}

// One thread's diff surface (a LazyDiffPanel), optionally with a diff on screen.
function DiffSurface(props: { seen: SeenPools; showDiff?: boolean }) {
  return (
    <DiffWorkerPoolProvider>
      {props.showDiff === false ? null : (
        <DiffWorkerPoolScope>
          <HostlessPoolProbe seen={props.seen} />
        </DiffWorkerPoolScope>
      )}
    </DiffWorkerPoolProvider>
  );
}

const withMode = (strict: boolean, element: ReactElement) =>
  strict ? <StrictMode>{element}</StrictMode> : element;

const poolSize = () =>
  vi.mocked(getOrCreateWorkerPoolSingleton).mock.calls[0]![0].poolOptions.poolSize ?? 0;
const distinctPools = () =>
  new Set(vi.mocked(getOrCreateWorkerPoolSingleton).mock.results.map((result) => result.value))
    .size;
// Lets the pool finish any asynchronous start-up a test could have missed.
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("DiffWorkerPoolProvider lifecycle (real React commits)", () => {
  it.each([false, true])(
    "hands the pool over when one surface unmounts as another's first diff renders (strict mode: %s)",
    async (strict) => {
      const root = createHostlessRoot();
      const seenA: SeenPools = [];
      const seenB: SeenPools = [];
      await act(async () => root.render(withMode(strict, <DiffSurface key="A" seen={seenA} />)));
      await vi.waitFor(() => expect(workerLog.constructed).toBe(poolSize()), { timeout: 20_000 });
      expect(workerLog.terminated).toBe(0);

      // Switching threads: A's diff pane unmounts in the commit that mounts B's,
      // and B's cached diff renders on that first render.
      await act(async () => root.render(withMode(strict, <DiffSurface key="B" seen={seenB} />)));
      await settle();

      const pool = seenA.at(-1);
      expect(pool).toBeDefined();
      expect(seenB.at(-1)).toBe(pool);
      expect(workerLog.terminated).toBe(0);
      expect(workerLog.constructed).toBe(poolSize());
      // B's pool is still the shared singleton, so no second pool can appear.
      expect(
        getOrCreateWorkerPoolSingleton(vi.mocked(getOrCreateWorkerPoolSingleton).mock.calls[0]![0]),
      ).toBe(pool);
      expect(distinctPools()).toBe(1);

      await act(async () => root.unmount());
      await settle();
      expect(workerLog.terminated).toBe(poolSize());
      expect(workerLog.constructed).toBe(workerLog.terminated);
    },
    30_000,
  );

  it.each([false, true])(
    "terminates the workers when the last surface unmounts (strict mode: %s)",
    async (strict) => {
      const root = createHostlessRoot();
      const seen: SeenPools = [];
      await act(async () => root.render(withMode(strict, <DiffSurface seen={seen} />)));
      await vi.waitFor(() => expect(workerLog.constructed).toBe(poolSize()), { timeout: 20_000 });
      await settle();
      // Strict mode's simulated unmount and remount must not touch the pool.
      expect(workerLog.terminated).toBe(0);
      expect(distinctPools()).toBe(1);

      await act(async () => root.unmount());
      await settle();
      expect(workerLog.terminated).toBe(poolSize());
      expect(workerLog.constructed).toBe(workerLog.terminated);
    },
    30_000,
  );

  it("terminates the pool when the incoming surface has no diff yet, and starts a fresh one for it later", async () => {
    const root = createHostlessRoot();
    const seenA: SeenPools = [];
    const seenB: SeenPools = [];
    await act(async () => root.render(<DiffSurface key="A" seen={seenA} />));
    await vi.waitFor(() => expect(workerLog.constructed).toBe(poolSize()), { timeout: 20_000 });

    await act(async () => root.render(<DiffSurface key="B" seen={seenB} showDiff={false} />));
    await settle();
    expect(workerLog.terminated).toBe(poolSize());

    await act(async () => root.render(<DiffSurface key="B" seen={seenB} />));
    await vi.waitFor(() => expect(workerLog.constructed).toBe(2 * poolSize()), { timeout: 20_000 });
    expect(seenB.at(-1)).not.toBe(seenA.at(-1));

    await act(async () => root.unmount());
    await settle();
    expect(workerLog.constructed).toBe(workerLog.terminated);
  }, 30_000);

  it("terminates a pool acquired by a render React discards", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const root = createHostlessRoot();
      const seen: SeenPools = [];
      const gate: { resume?: () => void } = {};
      const pending = new Promise<void>((resolve) => {
        gate.resume = resolve;
      });
      function SuspendsUntilResumed() {
        use(pending);
        return null;
      }
      // The surface renders (and acquires) beside a sibling that suspends, so
      // that render never commits; the fallback commits instead.
      await act(async () =>
        root.render(
          <Suspense fallback={null}>
            <DiffSurface seen={seen} />
            <SuspendsUntilResumed />
          </Suspense>,
        ),
      );
      expect(seen.at(-1)).toBeDefined();
      await vi.waitFor(() => expect(workerLog.constructed).toBe(poolSize()), { timeout: 20_000 });
      expect(workerLog.terminated).toBe(0);

      await vi.advanceTimersByTimeAsync(DIFF_WORKER_POOL_ORPHAN_SWEEP_MS);
      expect(workerLog.terminated).toBe(poolSize());

      // When the surface does commit later, it starts and owns a fresh pool.
      await act(async () => {
        gate.resume?.();
        await pending;
      });
      await vi.waitFor(() => expect(workerLog.constructed).toBe(2 * poolSize()), {
        timeout: 20_000,
      });
      await act(async () => root.unmount());
      await vi.advanceTimersByTimeAsync(DIFF_WORKER_POOL_ORPHAN_SWEEP_MS);
      expect(workerLog.constructed).toBe(workerLog.terminated);
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);
});

describe("createDiffWorkerPoolLease", () => {
  it("starts every worker as soon as the pool is constructed (library behaviour)", async () => {
    const lease = createDiffWorkerPoolLease();
    lease.hold();
    expect(workerLog.constructed).toBe(0);

    try {
      lease.acquire(POOL_SETUP);
      await vi.waitFor(() => expect(workerLog.constructed).toBe(3), { timeout: 20_000 });
    } finally {
      lease.unhold();
      lease.release();
    }
    expect(workerLog.terminated).toBe(3);
  }, 30_000);

  it("does not create a pool until acquired", () => {
    const lease = createDiffWorkerPoolLease();
    lease.hold();

    expect(lease.pools()).toEqual([]);
    expect(getOrCreateWorkerPoolSingleton).not.toHaveBeenCalled();
    lease.unhold();
    lease.release();
    expect(terminateWorkerPoolSingleton).not.toHaveBeenCalled();
  });

  it("does not let a surface that never used the pool terminate it", () => {
    const user = createDiffWorkerPoolLease();
    const bystander = createDiffWorkerPoolLease();
    user.hold();
    bystander.hold();
    user.acquire(POOL_SETUP);

    bystander.unhold();
    bystander.release();
    expect(terminateWorkerPoolSingleton).not.toHaveBeenCalled();
    user.unhold();
    user.release();
    expect(terminateWorkerPoolSingleton).toHaveBeenCalledTimes(1);
  });

  it("terminates its own pool, not a newer singleton, when that pool was replaced", async () => {
    const stale = createDiffWorkerPoolLease();
    stale.hold();
    const stalePool = stale.acquire(POOL_SETUP)!;
    await vi.waitFor(() => expect(workerLog.constructed).toBe(3), { timeout: 20_000 });
    // Someone else ends the singleton; the next surface gets a new one.
    terminateWorkerPoolSingleton();
    const terminatedBefore = workerLog.terminated;
    const fresh = createDiffWorkerPoolLease();
    fresh.hold();
    const freshPool = fresh.acquire(POOL_SETUP)!;
    expect(freshPool).not.toBe(stalePool);
    await vi.waitFor(() => expect(workerLog.constructed).toBe(6), { timeout: 20_000 });

    const terminateStale = vi.spyOn(stalePool, "terminate");
    vi.mocked(terminateWorkerPoolSingleton).mockClear();
    stale.unhold();
    stale.release();
    expect(terminateStale).toHaveBeenCalledTimes(1);
    expect(terminateWorkerPoolSingleton).not.toHaveBeenCalled();
    expect(workerLog.terminated).toBe(terminatedBefore);

    fresh.unhold();
    fresh.release();
    expect(terminateWorkerPoolSingleton).toHaveBeenCalledTimes(1);
    expect(workerLog.terminated).toBe(6);
  }, 30_000);

  it("returns no pool outside a browser", () => {
    vi.unstubAllGlobals();
    const lease = createDiffWorkerPoolLease();

    expect(lease.acquire(POOL_SETUP)).toBeUndefined();
    expect(getOrCreateWorkerPoolSingleton).not.toHaveBeenCalled();
  });
});
