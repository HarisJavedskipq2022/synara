import { act, useMemo } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const chunk = vi.hoisted(() => ({ attempts: 0, failuresLeft: 0 }));

// The KaTeX chunk fails to load `failuresLeft` more times, then loads. Registered
// per test (vi.doMock), since a mocked module that loaded once stays cached.
async function mockKatexChunk(
  importOriginal: <T>() => Promise<T>,
): Promise<typeof import("./rehypeKatexChunk")> {
  chunk.attempts += 1;
  if (chunk.failuresLeft > 0) {
    chunk.failuresLeft -= 1;
    throw new TypeError("Failed to fetch dynamically imported module");
  }
  return await importOriginal<typeof import("./rehypeKatexChunk")>();
}

type LazyKatexModule = typeof import("./lazyRehypeKatex");

interface MessageLog {
  parses: number;
  rendered: "none" | "placeholder" | "katex";
}

type HastNode = {
  type: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
};

function hasClass(node: HastNode, className: string): boolean {
  const classes = node.properties?.className;
  if (Array.isArray(classes) && classes.includes(className)) return true;
  return (node.children ?? []).some((child) => hasClass(child, className));
}

// The hast remark-math emits for `$x^2$`.
function inlineMathTree(): { children: HastNode[] } {
  return {
    children: [
      {
        type: "element",
        tagName: "p",
        properties: {},
        children: [
          {
            type: "element",
            tagName: "code",
            properties: { className: ["language-math", "math-inline"] },
            children: [{ type: "text", value: "x^2" } as HastNode],
          },
        ],
      },
    ],
  };
}

let lazyKatex: LazyKatexModule;
let createHostlessRoot: typeof import("../components/hostlessReactRoot.test-support").createHostlessRoot;

// Parses its math once per plugin entry, the way ChatMarkdown's cached blocks do.
function MathMessage(props: { log: MessageLog }) {
  const [plugin, options] = lazyKatex.useLazyRehypeKatexPlugin();
  const rendered = useMemo(() => {
    props.log.parses += 1;
    const tree = inlineMathTree();
    plugin(options)(tree, undefined);
    return hasClass(tree as HastNode, "katex")
      ? "katex"
      : hasClass(tree as HastNode, lazyKatex.KATEX_PENDING_CLASS_NAME)
        ? "placeholder"
        : "none";
  }, [plugin, options, props.log]);
  props.log.rendered = rendered;
  return null;
}

const newLog = (): MessageLog => ({ parses: 0, rendered: "none" });
const roundMs = () => lazyKatex.KATEX_LOAD_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);
const attemptsPerRound = () => lazyKatex.KATEX_LOAD_RETRY_DELAYS_MS.length + 1;

function setVisibility(page: EventTarget & { visibilityState: string }, state: string) {
  page.visibilityState = state;
  page.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.resetModules();
  vi.doUnmock("./rehypeKatexChunk");
  vi.doMock("./rehypeKatexChunk", mockKatexChunk);
  chunk.attempts = 0;
  chunk.failuresLeft = 0;
  lazyKatex = await import("./lazyRehypeKatex");
  ({ createHostlessRoot } = await import("../components/hostlessReactRoot.test-support"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("KaTeX chunk load failures", () => {
  it("retries a failed load and re-parses the waiting message once", async () => {
    chunk.failuresLeft = 1;
    const root = createHostlessRoot();
    const log = newLog();

    await act(async () => root.render(<MathMessage log={log} />));
    expect(log).toEqual({ parses: 1, rendered: "placeholder" });
    expect(chunk.attempts).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(lazyKatex.KATEX_LOAD_RETRY_DELAYS_MS[0]!);
    });
    expect(chunk.attempts).toBe(2);
    await act(async () => {
      await vi.waitFor(() => expect(lazyKatex.getLoadedRehypeKatex()).not.toBeNull());
    });
    expect(log).toEqual({ parses: 2, rendered: "katex" });

    await act(async () => root.unmount());
  });

  it("stops after bounded rounds when the chunk is gone, without re-rendering messages", async () => {
    chunk.failuresLeft = Number.POSITIVE_INFINITY;
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", page);
    const root = createHostlessRoot();
    const first = newLog();
    const notified = vi.fn();
    const unsubscribe = lazyKatex.subscribeRehypeKatex(notified);

    await act(async () => root.render(<MathMessage key="first" log={first} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(roundMs());
    });
    expect(chunk.attempts).toBe(attemptsPerRound());

    // More math while the load is failed does not start more loads.
    const second = newLog();
    await act(async () =>
      root.render(
        <>
          <MathMessage key="first" log={first} />
          <MathMessage key="second" log={second} />
        </>,
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(roundMs());
    });
    expect(chunk.attempts).toBe(attemptsPerRound());

    // Each return to the page starts one more round, up to the bound.
    for (let round = 1; round <= lazyKatex.KATEX_LOAD_MAX_VISIBILITY_ROUNDS + 2; round += 1) {
      setVisibility(page, "hidden");
      setVisibility(page, "visible");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(roundMs());
      });
    }
    expect(chunk.attempts).toBe(
      attemptsPerRound() * (1 + lazyKatex.KATEX_LOAD_MAX_VISIBILITY_ROUNDS),
    );

    // Math stays as its source, each message parsed once, nobody notified.
    expect(first).toEqual({ parses: 1, rendered: "placeholder" });
    expect(second).toEqual({ parses: 1, rendered: "placeholder" });
    expect(notified).not.toHaveBeenCalled();
    await expect(lazyKatex.loadRehypeKatex()).rejects.toThrow();
    expect(chunk.attempts).toBe(
      attemptsPerRound() * (1 + lazyKatex.KATEX_LOAD_MAX_VISIBILITY_ROUNDS),
    );

    unsubscribe();
    await act(async () => root.unmount());
  });

  it("loads on the next visit after a failed round, re-parsing the message once", async () => {
    chunk.failuresLeft = attemptsPerRound();
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", page);
    const root = createHostlessRoot();
    const log = newLog();

    await act(async () => root.render(<MathMessage log={log} />));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(roundMs());
    });
    expect(chunk.attempts).toBe(attemptsPerRound());
    expect(log).toEqual({ parses: 1, rendered: "placeholder" });

    setVisibility(page, "hidden");
    await act(async () => {
      setVisibility(page, "visible");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(chunk.attempts).toBe(attemptsPerRound() + 1);
    await act(async () => {
      await vi.waitFor(() => expect(lazyKatex.getLoadedRehypeKatex()).not.toBeNull());
    });
    expect(log).toEqual({ parses: 2, rendered: "katex" });

    await act(async () => root.unmount());
  });
});
