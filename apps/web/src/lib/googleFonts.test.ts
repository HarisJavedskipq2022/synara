import { describe, expect, it } from "vitest";

import {
  GOOGLE_FONTS_STYLESHEET_URL,
  ensureGoogleFontsStylesheet,
  fontFamilyListUsesGoogleFonts,
} from "./googleFonts";

type FakeLink = { rel: string; href: string; crossOrigin: string | null };

// Just enough of a document for the helper; the app's Vitest runs in Node.
function fakeDocument() {
  const links: FakeLink[] = [];
  const doc = {
    head: {
      querySelectorAll: () =>
        links.map((link) => ({
          getAttribute: (name: string) => (name === "href" ? link.href : null),
        })),
      append: (...added: FakeLink[]) => links.push(...added),
    },
    createElement: () => ({ rel: "", href: "", crossOrigin: null }),
  };
  return { doc: doc as unknown as Document, links };
}

describe("ensureGoogleFontsStylesheet", () => {
  it("adds the stylesheet once, however often it is asked", () => {
    const { doc, links } = fakeDocument();
    ensureGoogleFontsStylesheet(doc);
    ensureGoogleFontsStylesheet(doc);
    ensureGoogleFontsStylesheet(doc);
    expect(links).toEqual([
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "" },
      { rel: "stylesheet", href: GOOGLE_FONTS_STYLESHEET_URL, crossOrigin: null },
    ]);
  });

  it("requests the families and weights index.html used to", () => {
    const families = new URL(GOOGLE_FONTS_STYLESHEET_URL).searchParams.getAll("family");
    expect(families).toEqual([
      "Cal Sans",
      "DM Sans:ital,opsz,wght@0,9..40,300..800;1,9..40,300..800",
      "Geist:wght@100..900",
      "Geist Mono:wght@100..900",
      "Inter:opsz,wght@14..32,100..900",
    ]);
  });

  it("does nothing without a document", () => {
    expect(() => ensureGoogleFontsStylesheet(undefined)).not.toThrow();
  });
});

describe("fontFamilyListUsesGoogleFonts", () => {
  it("matches whole family names, quoted or not, in any case", () => {
    expect(fontFamilyListUsesGoogleFonts("Inter")).toBe(true);
    expect(fontFamilyListUsesGoogleFonts("'Cal Sans', system-ui")).toBe(true);
    expect(fontFamilyListUsesGoogleFonts('"GEIST MONO", monospace')).toBe(true);
    expect(fontFamilyListUsesGoogleFonts("Inter Tight, Geist Sans")).toBe(false);
    expect(fontFamilyListUsesGoogleFonts("")).toBe(false);
    expect(fontFamilyListUsesGoogleFonts(null)).toBe(false);
  });
});
