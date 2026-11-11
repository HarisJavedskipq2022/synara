// FILE: hostlessReactRoot.test-support.ts
// Purpose: Run real react-dom/client commits in the Node test environment (no DOM), for trees
//          that render no host elements, so tests can observe effect order and re-renders.
// Layer: Test support
// Exports: createHostlessRoot

import { createRoot, type Root } from "react-dom/client";
import { vi } from "vitest";

/**
 * A root over a document just big enough for react-dom to commit trees of
 * function components and providers that return no host elements. Globals are
 * stubbed with `vi.stubGlobal`; undo them with `vi.unstubAllGlobals()`.
 */
export function createHostlessRoot(): Root {
  const ownerDocument: Record<string, unknown> = {
    nodeType: 9,
    activeElement: null,
    defaultView: globalThis,
    addEventListener() {},
    removeEventListener() {},
  };
  const container = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    ownerDocument,
    firstChild: null,
    textContent: "",
    addEventListener() {},
    removeEventListener() {},
  };
  ownerDocument.documentElement = container;
  ownerDocument.body = container;
  if (typeof window === "undefined") vi.stubGlobal("window", globalThis);
  if (typeof document === "undefined") vi.stubGlobal("document", ownerDocument);
  // react-dom checks the active element with `instanceof HTMLIFrameElement`.
  vi.stubGlobal("HTMLIFrameElement", function HTMLIFrameElement() {});
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  return createRoot(container as unknown as HTMLElement);
}
