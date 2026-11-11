import { afterEach, describe, expect, it, vi } from "vitest";

import { GOOGLE_FONTS_STYLESHEET_URL } from "../lib/googleFonts";
import {
  DEFAULT_THEME_STATE,
  serializeThemeState,
  setThemeCodeThemeId,
  type ThemeState,
} from "../theme/theme.logic";

// The app's Vitest runs in Node: a document just large enough for applyThemeState, which
// useTheme.ts runs on module load, the same apply every theme change goes through.
function installFakeDom(storedState: ThemeState) {
  const headLinks: Array<{ rel: string; href: string }> = [];
  const storage = new Map([["synara:theme", serializeThemeState(storedState)]]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("window", {
    frameElement: null,
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList: { add() {}, remove() {}, toggle() {} },
      style: { setProperty() {}, removeProperty() {} },
      setAttribute() {},
    },
    head: {
      querySelectorAll: () =>
        headLinks.map((link) => ({
          getAttribute: (name: string) => (name === "href" ? link.href : null),
        })),
      append: (...links: Array<{ rel: string; href: string }>) => headLinks.push(...links),
    },
    createElement: () => ({ rel: "", href: "" }),
  });
  return headLinks;
}

async function applyStoredTheme(state: ThemeState) {
  const headLinks = installFakeDom(state);
  vi.resetModules();
  await import("./useTheme");
  return headLinks.filter((link) => link.rel === "stylesheet").map((link) => link.href);
}

const lightState = (codeThemeId: string, systemUiFont: boolean): ThemeState => ({
  ...setThemeCodeThemeId(DEFAULT_THEME_STATE, "light", codeThemeId),
  mode: "light",
  systemUiFont,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applying a theme", () => {
  it("requests no web fonts for the default theme", async () => {
    expect(await applyStoredTheme(DEFAULT_THEME_STATE)).toEqual([]);
    expect(await applyStoredTheme({ ...DEFAULT_THEME_STATE, systemUiFont: false })).toEqual([]);
  });

  it("adds the stylesheet for a theme whose code font is a web font", async () => {
    // Vercel's code font is Geist Mono, applied even with the system UI font on.
    expect(await applyStoredTheme(lightState("vercel", true))).toEqual([
      GOOGLE_FONTS_STYLESHEET_URL,
    ]);
  });

  it("adds it for a web UI font only while the system UI font is off", async () => {
    expect(await applyStoredTheme(lightState("linear", true))).toEqual([]);
    expect(await applyStoredTheme(lightState("linear", false))).toEqual([
      GOOGLE_FONTS_STYLESHEET_URL,
    ]);
  });
});
