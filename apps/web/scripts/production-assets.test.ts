import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyCentralIconStrokeWidth,
  applyProductionIconStrokeWidth,
  CENTRAL_ICON_DIRECTORIES,
  CENTRAL_ICON_STROKE_WIDTH,
  CENTRAL_OUTLINE_ICON_DIRECTORY,
  pruneProductionIcons,
} from "./production-assets";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "synara-icons-"));
  roots.push(root);
  const source = path.join(root, "src");
  const contracts = path.join(root, "contracts");
  const publicDir = path.join(root, "public");
  const dist = path.join(root, "dist");
  await fs.mkdir(source);
  await fs.mkdir(contracts);
  for (const dir of CENTRAL_ICON_DIRECTORIES) {
    await fs.mkdir(path.join(publicDir, dir), { recursive: true });
    await fs.mkdir(path.join(dist, dir), { recursive: true });
    for (const name of ["star", "cloud", "bag", "unused"]) {
      const svg = `<svg data-variant="${dir}" data-name="${name}"/>`;
      await fs.writeFile(path.join(publicDir, dir, `${name}.svg`), svg);
      await fs.writeFile(path.join(dist, dir, `${name}.svg`), svg);
    }
  }
  return { source, contracts, publicDir, dist };
}

describe("production icon pruning", () => {
  it("keeps both variants, shared persisted names, and .svg-suffixed literals byte-for-byte", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, "icons.tsx"), 'const icons = ["star", `cloud.svg`];');
    await fs.writeFile(path.join(f.contracts, "schema.ts"), 'const allowed = ["bag"];');
    for (const dir of CENTRAL_ICON_DIRECTORIES) {
      await fs.writeFile(path.join(f.dist, dir, "unused.svg.gz"), "old gzip");
      await fs.writeFile(path.join(f.dist, dir, "unused.svg.br"), "old brotli");
    }
    await pruneProductionIcons(f.publicDir, f.dist, [f.source, f.contracts]);
    for (const dir of CENTRAL_ICON_DIRECTORIES) {
      expect((await fs.readdir(path.join(f.dist, dir))).sort()).toEqual([
        "bag.svg",
        "cloud.svg",
        "star.svg",
      ]);
      for (const name of ["bag", "cloud", "star"]) {
        expect(await fs.readFile(path.join(f.dist, dir, `${name}.svg`))).toEqual(
          await fs.readFile(path.join(f.publicDir, dir, `${name}.svg`)),
        );
      }
    }
    // A repeated/watch pass is safe even though unused outputs are already gone.
    await pruneProductionIcons(f.publicDir, f.dist, [f.source, f.contracts]);
  });

  it("does not delete an icon set when no references are discoverable", async () => {
    const f = await fixture();
    await pruneProductionIcons(f.publicDir, f.dist, [f.source]);
    for (const dir of CENTRAL_ICON_DIRECTORIES) {
      expect(await fs.readdir(path.join(f.dist, dir))).toHaveLength(4);
    }
  });
});

describe("outline icon stroke weight", () => {
  it("re-weights the shipped 1.5 strokes and leaves a glyph's other weights alone", () => {
    const svg =
      '<svg><path stroke-width="1.5"/><path stroke-width="0.5"/><path stroke-width="1.59375"/></svg>';
    expect(applyCentralIconStrokeWidth(svg)).toBe(
      `<svg><path stroke-width="${CENTRAL_ICON_STROKE_WIDTH}"/><path stroke-width="0.5"/><path stroke-width="1.59375"/></svg>`,
    );
  });

  it("rewrites only the built outline icons", async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), "arbor-icon-stroke-"));
    roots.push(root);
    const shipped = '<svg><path stroke-width="1.5"/></svg>';
    for (const directory of CENTRAL_ICON_DIRECTORIES) {
      await fs.mkdir(path.join(root, directory), { recursive: true });
      await fs.writeFile(path.join(root, directory, "star.svg"), shipped);
    }
    await applyProductionIconStrokeWidth(root);
    for (const directory of CENTRAL_ICON_DIRECTORIES) {
      const built = await fs.readFile(path.join(root, directory, "star.svg"), "utf8");
      expect(built.includes(`stroke-width="${CENTRAL_ICON_STROKE_WIDTH}"`)).toBe(
        directory === CENTRAL_OUTLINE_ICON_DIRECTORY,
      );
    }
  });
});
