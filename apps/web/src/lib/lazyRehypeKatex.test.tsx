import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { describe, expect, it, vi } from "vitest";

const chunkLog = vi.hoisted(() => {
  const log: { imports: number; gate?: Promise<void>; release?: () => void } = { imports: 0 };
  log.gate = new Promise<void>((resolve) => {
    log.release = resolve;
  });
  return log;
});

// Counts loads of the lazily imported KaTeX chunk, and holds the load open so the
// placeholder phase can be observed.
vi.mock("./rehypeKatexChunk", async (importOriginal) => {
  chunkLog.imports += 1;
  await chunkLog.gate;
  return await importOriginal<typeof import("./rehypeKatexChunk")>();
});

vi.mock("@pierre/diffs", () => ({
  getFiletypeFromFileName: (fileName: string) => (fileName.endsWith(".ts") ? "ts" : "text"),
  getSharedHighlighter: () =>
    Promise.resolve({
      codeToHtml(code: string) {
        return `<pre class="shiki"><code>${code}</code></pre>`;
      },
    }),
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

const {
  getLoadedRehypeKatex,
  KATEX_PENDING_CLASS_NAME,
  loadRehypeKatex,
  MARKDOWN_KATEX_OPTIONS,
  rehypeLazyKatex,
  subscribeRehypeKatex,
} = await import("./lazyRehypeKatex");
const { default: ChatMarkdown } = await import("../components/ChatMarkdown");

const HEAVY_MODULE_TEST_TIMEOUT_MS = 30_000;
const PENDING_PATTERN = new RegExp(`class="${KATEX_PENDING_CLASS_NAME}"`, "g");

function renderChatMarkdown(
  text: string,
  options: { isStreaming?: boolean; parseHtml?: boolean } = {},
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui: ReactElement = (
    <QueryClientProvider client={client}>
      <ChatMarkdown
        text={text}
        cwd={undefined}
        isStreaming={options.isStreaming ?? false}
        parseHtml={options.parseHtml ?? false}
      />
    </QueryClientProvider>
  );
  return renderToStaticMarkup(ui);
}

const countPending = (markup: string) => (markup.match(PENDING_PATTERN) ?? []).length;

// Text that has dollars or TeX look-alikes but that the pipeline renders without math.
const NOT_MATH = [
  "It costs $5 to $10 per seat.",
  "Prices $5, $5-$10 and $29.470 this year.",
  "Run `echo $HOME` or set $PATH before $SHELL starts.",
  "Use $USD$ for price and $PATH$ for shell lookup.",
  "Escape \\$E=mc^2\\$ when you want literal TeX.",
  '```sh\nexport PATH=$HOME/bin:$PATH\necho "$1 and $2"\n```',
  "```ts\nconst price = `$${amount}`;\n```",
  "Files: [_chat.$threadId.tsx](/src/routes/_chat.$threadId.tsx)",
  "Use $ASSET for ![preview](https://example.com/assets/$variant.png).",
  // remark-math does not enable these delimiters, so they stay text today too.
  "Bracket forms \\(x^2\\) and \\[y^2\\] are not math here.",
];

// Each syntax the pipeline renders as math, with the number of math elements.
const MATH: Array<[label: string, text: string, count: number]> = [
  ["inline $…$", "Euler wrote $e^{i\\pi} + 1 = 0$.", 1],
  ["display $$ block", "$$\n\\int_0^1 x^2 \\, dx\n$$", 1],
  ["inline $$…$$", "Inline $$a+b$$ in prose.", 1],
  ["math code fence", "```math\nE = mc^2\n```", 1],
  ["numeric inline", "Math $2x$, $2.5x$ and $2^{10}$.", 3],
  ["table cells", "| Op | FLOPs |\n|---|---:|\n| Read | $d_kd_v$ |\n| Write | $2d_kd_v$ |", 2],
  ["list and quote", "- item $a_1$\n\n> quoted $b_2$", 2],
  ["math beside a price", "Price $5. Then $x[0]+y[1]$ holds.", 1],
];

describe("lazy KaTeX detection", () => {
  it.each(NOT_MATH)(
    "renders look-alikes without placeholders or a KaTeX load: %s",
    (text) => {
      const markup = renderChatMarkdown(text);

      expect(countPending(markup)).toBe(0);
      expect(markup).not.toContain('class="katex"');
      expect(chunkLog.imports).toBe(0);
      expect(getLoadedRehypeKatex()).toBeNull();
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );

  it.each(MATH)(
    "shows the TeX source while KaTeX loads: %s",
    (_label, text, count) => {
      const markup = renderChatMarkdown(text);

      expect(countPending(markup)).toBe(count);
      expect(markup).not.toContain('class="katex"');
      expect(markup).not.toContain("language-math");
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );

  it("keeps display math in a centred block while pending and inline math inline", () => {
    const markup = renderChatMarkdown("Inline $x^2$.\n\n$$\n\\frac{a}{b}\n$$");

    expect(markup).toContain(`<span class="${KATEX_PENDING_CLASS_NAME}">x^2</span>`);
    expect(markup).toMatch(
      new RegExp(
        `<span class="${KATEX_PENDING_CLASS_NAME}" style="display:block;margin:0.85rem 0;padding:0.1rem 0 0.35rem;text-align:center">\\\\frac\\{a\\}\\{b\\}</span>`,
      ),
    );
  });

  it("detects math in a streamed tail", () => {
    const markup = renderChatMarkdown("First paragraph.\n\nThen $x_1 + x_2$ and more", {
      isStreaming: true,
    });

    expect(countPending(markup)).toBe(1);
  });

  it(
    "loads the chunk once however many parses find math, and notifies once",
    async () => {
      const listener = vi.fn();
      const unsubscribe = subscribeRehypeKatex(listener);
      const tracker = { renderedPendingMath: false };
      const transform = rehypeLazyKatex({ tracker });
      for (let index = 0; index < 5; index += 1) {
        transform(
          {
            children: [
              {
                type: "element",
                tagName: "code",
                properties: { className: ["language-math", "math-inline"] },
                children: [{ type: "text", value: "x" }],
              },
            ],
          },
          undefined,
        );
      }

      expect(tracker.renderedPendingMath).toBe(true);
      expect(listener).not.toHaveBeenCalled();
      chunkLog.release?.();
      await loadRehypeKatex();
      await loadRehypeKatex();
      expect(chunkLog.imports).toBe(1);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(getLoadedRehypeKatex()).toBe(rehypeKatex);
      unsubscribe();
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );
});

describe("lazy KaTeX once loaded", () => {
  type MarkdownProps = Parameters<typeof ReactMarkdown>[0];
  // ChatMarkdown's math syntax: remark-math with single-dollar inline math.
  const REMARK_PLUGINS: MarkdownProps["remarkPlugins"] = [
    remarkGfm,
    [remarkMath, { singleDollarTextMath: true }],
  ];
  const renderWith = (text: string, rehypePlugins: MarkdownProps["rehypePlugins"]) =>
    renderToStaticMarkup(
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehypePlugins}>
        {text}
      </ReactMarkdown>,
    );

  it.each(MATH)(
    "renders exactly what a static rehype-katex renders: %s",
    async (_label, text) => {
      await loadRehypeKatex();
      const tracker = { renderedPendingMath: false };

      const lazy = renderWith(text, [[rehypeLazyKatex, { tracker }]]);
      const staticOutput = renderWith(text, [[rehypeKatex, MARKDOWN_KATEX_OPTIONS]]);

      expect(lazy).toBe(staticOutput);
      expect(lazy).toContain('class="katex"');
      // Rendered synchronously, without a placeholder pass.
      expect(tracker.renderedPendingMath).toBe(false);
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );

  it.each(MATH)(
    "renders math synchronously in ChatMarkdown: %s",
    async (_label, text, count) => {
      await loadRehypeKatex();
      const markup = renderChatMarkdown(text);

      expect(countPending(markup)).toBe(0);
      expect(markup).not.toContain("katex-error");
      expect(
        (markup.match(/class="katex"/g) ?? []).length +
          (markup.match(/class="katex-display"/g) ?? []).length,
      ).toBeGreaterThanOrEqual(count);
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );

  it.each(NOT_MATH)("still renders look-alikes as text: %s", async (text) => {
    await loadRehypeKatex();
    const markup = renderChatMarkdown(text);

    expect(markup).not.toContain('class="katex"');
  });
});
