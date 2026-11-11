// FILE: rehypeKatexChunk.ts
// Purpose: The lazily imported KaTeX chunk: rehype-katex plus the KaTeX stylesheet, so the
//          stylesheet is in place before the first math renders.
// Layer: Markdown rendering
// Exports: rehypeKatex (default)
// Depends on: rehype-katex, katex stylesheet. Imported only by lazyRehypeKatex.ts.

import "katex/dist/katex.min.css";

export { default } from "rehype-katex";
