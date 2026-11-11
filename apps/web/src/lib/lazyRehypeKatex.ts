// FILE: lazyRehypeKatex.ts
// Purpose: Load rehype-katex and the KaTeX stylesheet only once a rendered message contains
//          math. Until then, math renders as its TeX source in a placeholder span; after the
//          first load KaTeX stays loaded and later messages render math synchronously.
// Layer: Markdown rendering
// Exports: rehypeLazyKatex, useLazyRehypeKatexPlugin, loadRehypeKatex, getLoadedRehypeKatex,
//          subscribeRehypeKatex, MARKDOWN_KATEX_OPTIONS, KATEX_PENDING_CLASS_NAME
// Depends on: rehypeKatexChunk.ts (dynamic import only)

import { useMemo, useState, useSyncExternalStore } from "react";

type RehypeKatex = typeof import("./rehypeKatexChunk").default;

// The options ChatMarkdown has always passed to rehype-katex.
export const MARKDOWN_KATEX_OPTIONS = {
  output: "htmlAndMathml",
  strict: false,
  throwOnError: false,
} as const;

/** Class on the placeholder that stands in for math until KaTeX has loaded. */
export const KATEX_PENDING_CLASS_NAME = "katex-pending";
// Mirrors the box of `.chat-markdown .katex-display` (index.css) and the KaTeX stylesheet's
// centering, so display math keeps its place while the stylesheet is not loaded yet.
const PENDING_DISPLAY_STYLE =
  "display:block;margin:0.85rem 0;padding:0.1rem 0 0.35rem;text-align:center";

/** Waits before each retry of a failed chunk load, within one round of attempts. */
export const KATEX_LOAD_RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 15_000];
/** Further rounds, each started when the page next becomes visible, after a failed round. */
export const KATEX_LOAD_MAX_VISIBILITY_ROUNDS = 2;

let loadedRehypeKatex: RehypeKatex | null = null;
let pendingLoad: Promise<RehypeKatex> | null = null;
let failedRounds = 0;
const listeners = new Set<() => void>();

function importChunk(attempt: number): Promise<RehypeKatex> {
  return import("./rehypeKatexChunk").then(
    (module) => module.default,
    (error: unknown) => {
      const delay = KATEX_LOAD_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      return new Promise<void>((resolve) => setTimeout(resolve, delay)).then(() =>
        importChunk(attempt + 1),
      );
    },
  );
}

// After a failed round (a transient fetch failure, or a deploy that removed the
// hashed chunk), try one more round when the user comes back to the page.
function retryWhenPageVisible(): void {
  if (typeof document === "undefined") return;
  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    pendingLoad = null;
    void loadRehypeKatex().catch(() => undefined);
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
}

/**
 * Starts (once) and returns the KaTeX chunk load. A failed attempt is retried
 * after each of KATEX_LOAD_RETRY_DELAYS_MS; a failed round is retried when the
 * page next becomes visible, at most KATEX_LOAD_MAX_VISIBILITY_ROUNDS times.
 * Between rounds, and after the last one, calls return the failed load without
 * trying again, so parsing math never starts more loads. Subscribers are
 * notified once, on success; until then math keeps showing as placeholders.
 */
export function loadRehypeKatex(): Promise<RehypeKatex> {
  pendingLoad ??= importChunk(0).then(
    (rehypeKatex) => {
      loadedRehypeKatex = rehypeKatex;
      for (const listener of listeners) listener();
      return rehypeKatex;
    },
    (error: unknown) => {
      failedRounds += 1;
      if (failedRounds <= KATEX_LOAD_MAX_VISIBILITY_ROUNDS) retryWhenPageVisible();
      throw error;
    },
  );
  return pendingLoad;
}

export function getLoadedRehypeKatex(): RehypeKatex | null {
  return loadedRehypeKatex;
}

export function subscribeRehypeKatex(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type HastText = { type: "text"; value: string };
type HastElement = {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: HastNode[];
};
type HastNode = HastElement | HastText | { type: string; children?: HastNode[]; value?: unknown };
type HastParent = { children: HastNode[] };

function isElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

function classList(element: HastElement): readonly unknown[] {
  const className = element.properties.className;
  return Array.isArray(className) ? className : [];
}

function hasMathClass(element: HastElement): boolean {
  const classes = classList(element);
  return (
    classes.includes("language-math") ||
    classes.includes("math-display") ||
    classes.includes("math-inline")
  );
}

function textContent(node: HastNode): string {
  if (node.type === "text") return typeof node.value === "string" ? node.value : "";
  return "children" in node && node.children ? node.children.map(textContent).join("") : "";
}

function pendingMathNode(source: string, display: boolean): HastElement {
  return {
    type: "element",
    tagName: "span",
    properties: {
      className: [KATEX_PENDING_CLASS_NAME],
      ...(display ? { style: PENDING_DISPLAY_STYLE } : {}),
    },
    children: [{ type: "text", value: source }],
  };
}

/**
 * Replaces exactly the elements rehype-katex would render (any element with a
 * `language-math`, `math-display` or `math-inline` class; a `pre` around a
 * `code.language-math` is replaced whole, in display mode) with their TeX
 * source. Returns whether any math was found.
 */
function replaceMathWithPlaceholders(parent: HastParent): boolean {
  let found = false;
  const { children } = parent;
  for (const [index, child] of children.entries()) {
    // Only the root and elements have children in hast.
    if (!isElement(child)) continue;
    if (
      child.tagName === "pre" &&
      child.children.some(
        (inner) =>
          isElement(inner) &&
          inner.tagName === "code" &&
          classList(inner).includes("language-math"),
      )
    ) {
      children[index] = pendingMathNode(textContent(child), true);
      found = true;
    } else if (hasMathClass(child)) {
      children[index] = pendingMathNode(
        textContent(child),
        classList(child).includes("math-display"),
      );
      found = true;
    } else if (replaceMathWithPlaceholders(child)) {
      found = true;
    }
  }
  return found;
}

/** Per-message flag: set when the message rendered a math placeholder. */
export interface LazyKatexTracker {
  renderedPendingMath: boolean;
}

interface RehypeLazyKatexOptions {
  readonly tracker?: LazyKatexTracker;
  /** Changes once KaTeX replaces this message's placeholders, so cached blocks re-parse. */
  readonly katexReady?: boolean;
}

/**
 * Rehype plugin in rehype-katex's place: runs rehype-katex with
 * MARKDOWN_KATEX_OPTIONS once it is loaded; before that it renders math as
 * placeholders and starts the load.
 */
export function rehypeLazyKatex(options?: RehypeLazyKatexOptions) {
  return (tree: HastParent, file: unknown): void => {
    const rehypeKatex = loadedRehypeKatex;
    if (rehypeKatex) {
      const transform = rehypeKatex(MARKDOWN_KATEX_OPTIONS) as (
        tree: unknown,
        file: unknown,
      ) => void;
      transform(tree, file);
      return;
    }
    if (!replaceMathWithPlaceholders(tree)) return;
    if (options?.tracker) options.tracker.renderedPendingMath = true;
    void loadRehypeKatex().catch(() => undefined);
  };
}

function createLazyKatexTracker(): LazyKatexTracker {
  return { renderedPendingMath: false };
}

const getServerKatexReady = () => false;

/**
 * The rehype plugin entry for one ChatMarkdown. Its identity changes once,
 * when KaTeX finishes loading after this message showed placeholders; messages
 * that never showed one do not re-render when KaTeX arrives.
 */
export function useLazyRehypeKatexPlugin(): [typeof rehypeLazyKatex, RehypeLazyKatexOptions] {
  const [tracker] = useState(createLazyKatexTracker);
  const katexReady = useSyncExternalStore(
    subscribeRehypeKatex,
    () => tracker.renderedPendingMath && loadedRehypeKatex !== null,
    getServerKatexReady,
  );
  return useMemo(() => [rehypeLazyKatex, { tracker, katexReady }], [tracker, katexReady]);
}
