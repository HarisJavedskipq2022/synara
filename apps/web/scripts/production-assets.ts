// FILE: production-assets.ts
// Purpose: Prune unreferenced production icons while retaining both visual variants, and
//          set the outline icons' stroke weight.
// Layer: Web build helper (not imported by the client)

import fs from "node:fs/promises";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"]);
export const CENTRAL_ICON_DIRECTORIES = ["central-icons-reversed", "central-icons-fill"] as const;

export async function listFiles(root: string): Promise<string[]> {
  const entries = await fs
    .readdir(root, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
  const files: string[] = [];
  for (const entry of entries) {
    const name = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(name)));
    else if (entry.isFile()) files.push(name);
  }
  return files;
}

export async function pruneProductionIcons(
  publicDirectory: string,
  outputDirectory: string,
  sourceRoots: readonly string[],
): Promise<void> {
  // Include shared contracts: persisted choices (for example Space icons) are
  // dynamic at render time, but their allowed names are literals in the schema.
  const required = new Set<string>();
  const literal = /["'`]([a-z0-9][a-z0-9-]*)(?:\.svg)?["'`]/g;
  for (const root of sourceRoots) {
    for (const file of await listFiles(root)) {
      if (!SOURCE_EXTENSIONS.has(path.extname(file))) continue;
      for (const match of (await fs.readFile(file, "utf8")).matchAll(literal)) {
        if (match[1]) required.add(match[1]);
      }
    }
  }
  for (const directory of CENTRAL_ICON_DIRECTORIES) {
    const publicFiles = await listFiles(path.join(publicDirectory, directory));
    const available = publicFiles
      .filter((file) => file.endsWith(".svg"))
      .map((file) => path.basename(file, ".svg"));
    const retained = new Set(available.filter((name) => required.has(name)));
    // Fail conservatively when the source scan cannot identify this set.
    if (retained.size === 0) continue;
    let removed = 0;
    for (const name of available) {
      if (retained.has(name)) continue;
      await Promise.all(
        [".svg", ".svg.gz", ".svg.br"].map((suffix) =>
          fs.rm(path.join(outputDirectory, directory, `${name}${suffix}`), { force: true }),
        ),
      );
      removed += 1;
    }
    console.info(
      `[central-icons] ${directory}: retained ${retained.size}/${available.length}, pruned ${removed}.`,
    );
  }
}

/** The outline set's folder: the only one whose glyphs are drawn with strokes. */
export const CENTRAL_OUTLINE_ICON_DIRECTORY = "central-icons-reversed";
/**
 * Stroke weight for the outline icons, in the icons' 24-unit box. The shipped files draw at
 * 1.5, which lands near one pixel at the 16-20px sizes the app uses and reads thinner than
 * Codex's icons. The files stay as shipped; the weight is applied when they are served (dev)
 * and when they are copied into a build, so the icon set can be updated without re-editing it.
 */
export const CENTRAL_ICON_STROKE_WIDTH = "1.75";
const SHIPPED_STROKE_WIDTH = /stroke-width="1\.5"/g;

/** One outline icon at the app's stroke weight. Other weights in a glyph are details, kept. */
export function applyCentralIconStrokeWidth(svg: string): string {
  return svg.replace(SHIPPED_STROKE_WIDTH, `stroke-width="${CENTRAL_ICON_STROKE_WIDTH}"`);
}

/** Rewrites the built copies of the outline icons. Run before compression. */
export async function applyProductionIconStrokeWidth(outputDirectory: string): Promise<void> {
  const files = (
    await listFiles(path.join(outputDirectory, CENTRAL_OUTLINE_ICON_DIRECTORY))
  ).filter((file) => file.endsWith(".svg"));
  await Promise.all(
    files.map(async (file) => {
      const source = await fs.readFile(file, "utf8");
      const next = applyCentralIconStrokeWidth(source);
      if (next !== source) await fs.writeFile(file, next);
    }),
  );
  console.info(
    `[central-icons] stroke width ${CENTRAL_ICON_STROKE_WIDTH} applied to ${files.length} icons.`,
  );
}
