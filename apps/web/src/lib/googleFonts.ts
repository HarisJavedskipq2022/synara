// FILE: googleFonts.ts
// Purpose: Loads the Google Fonts stylesheet only when something about to render names one of
//          its families, so a launch with default settings makes no request to Google.
// Layer: Browser utility (also imported by the boot screens, so it has no app imports)
// Exports: ensureGoogleFontsStylesheet, fontFamilyListUsesGoogleFonts

// The families and weights index.html used to request on every launch, unchanged.
export const GOOGLE_FONTS_STYLESHEET_URL =
  "https://fonts.googleapis.com/css2?family=Cal+Sans&family=DM+Sans:ital,opsz,wght@0,9..40,300..800;1,9..40,300..800&family=Geist:wght@100..900&family=Geist+Mono:wght@100..900&family=Inter:opsz,wght@14..32,100..900&display=swap";

const GOOGLE_FONT_FAMILIES = new Set(["cal sans", "dm sans", "geist", "geist mono", "inter"]);

/** Whether a CSS font-family list (as typed in a theme font field) names a family loaded here. */
export function fontFamilyListUsesGoogleFonts(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.split(",").some((family) =>
    GOOGLE_FONT_FAMILIES.has(
      family
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2")
        .trim()
        .toLowerCase(),
    ),
  );
}

/**
 * Adds the stylesheet once per document. A script-inserted stylesheet blocks neither rendering
 * nor scripts, like the promoted preload index.html used to carry; text paints in its fallback
 * font until the face arrives (`display=swap`).
 */
export function ensureGoogleFontsStylesheet(doc: Document | undefined = globalThis.document): void {
  // Some tests stub only part of the DOM.
  if (
    typeof doc?.head?.querySelectorAll !== "function" ||
    typeof doc.createElement !== "function"
  ) {
    return;
  }
  for (const link of doc.head.querySelectorAll("link")) {
    if (link.getAttribute("href") === GOOGLE_FONTS_STYLESHEET_URL) return;
  }
  // The stylesheet names its font files on this origin; open that connection meanwhile.
  const preconnect = doc.createElement("link");
  preconnect.rel = "preconnect";
  preconnect.href = "https://fonts.gstatic.com";
  preconnect.crossOrigin = "";
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = GOOGLE_FONTS_STYLESHEET_URL;
  doc.head.append(preconnect, link);
}
