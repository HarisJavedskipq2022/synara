import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { composerOverlayScrollFadeVars } from "./components/chat/composerOverlay";

// The scroll-fade utilities derive custom properties from inputs a scroll timeline animates
// on every scroll tick. An unregistered custom property inherits, so each tick would restyle
// every element under the scroll container (the whole transcript, ~3,000 elements while a
// reply streams). Registered with `inherits: false`, a tick restyles only that container.
// That is safe only because each of these is set and read on the element carrying the
// utility. Root tokens descendants inherit (`--scroll-edge-fade-size`, `--scroll-fade-size`,
// `--scroll-fade-reveal`) and the size modifiers (`scroll-fade-*`, `scroll-fade-t-*`, …)
// stay inherited.
const DERIVED_PROPERTIES = [
  "--_scroll-fade-size-t",
  "--_scroll-fade-size-b",
  "--_scroll-fade-size-s",
  "--_scroll-fade-size-e",
  "--scroll-fade-block",
  "--scroll-fade-inline",
  "--_scroll-edge-fade-b-start",
  "--scroll-edge-fade-edges",
  "--scroll-edge-fade-glass",
  "--scroll-edge-fade-layer",
  "--scroll-edge-fade-inset-b",
  "--scroll-edge-fade-tuck",
];

const css = readFileSync(join(import.meta.dirname, "index.css"), "utf8");

function nonInheritedRegistrations(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/@property\s+(--[\w-]+)\s*\{([^}]*)\}/g)) {
    if (/inherits:\s*false/.test(match[2]!)) names.add(match[1]!);
  }
  return names;
}

/** Body of each block opened by `prelude` (matched up to its `{`), braces balanced. */
function blockBodies(source: string, prelude: RegExp): string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(prelude)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    while (end < source.length && depth > 0) {
      if (source[end] === "{") depth += 1;
      if (source[end] === "}") depth -= 1;
      end += 1;
    }
    bodies.push(source.slice(start, end - 1));
  }
  return bodies;
}

function declaredProperties(bodies: string[]): Set<string> {
  const names = new Set<string>();
  for (const body of bodies) {
    for (const match of body.matchAll(/(?<![\w-])(--[\w-]+)\s*:/g)) names.add(match[1]!);
  }
  return names;
}

describe("scroll-fade custom property registration", () => {
  const registered = nonInheritedRegistrations(css);

  it("registers every derived scroll-fade property as non-inherited", () => {
    expect(DERIVED_PROPERTIES.filter((name) => !registered.has(name))).toEqual([]);
  });

  it("registers each property the fade utilities declare", () => {
    // Size-modifier utilities (`scroll-fade-*`, `scroll-fade-t-*`, …) end in `-*` and set
    // inherited inputs, so they are excluded.
    const declared = declaredProperties([
      ...blockBodies(css, /@utility\s+scroll-(?:edge-)?fade(?:-[a-z]+)?\s*\{/g),
      ...blockBodies(css, /\.scroll-edge-fade\s*\{/g),
    ]);
    expect(declared.size).toBeGreaterThan(0);
    expect([...declared].filter((name) => !registered.has(name))).toEqual([]);
  });

  it("registers the variables the composer sets inline on the transcript", () => {
    const inline = Object.keys(composerOverlayScrollFadeVars(140, 72) ?? {});
    expect(inline.length).toBeGreaterThan(0);
    expect(inline.filter((name) => !registered.has(name))).toEqual([]);
  });

  it("keeps the inherited root tokens unregistered", () => {
    const inheritedTokens = [
      "--scroll-edge-fade-size",
      "--scroll-fade-size",
      "--scroll-fade-reveal",
    ];
    expect(inheritedTokens.filter((name) => registered.has(name))).toEqual([]);
  });
});
