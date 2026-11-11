import { describe, expect, it } from "vitest";

import { BUILTIN_BANNERS } from "./builtins";
import {
  BANNER_KEY,
  bannerSource,
  createBannerStore,
  DEFAULT_BANNER,
  MAX_BANNER_CHARACTERS,
  parseBannerPreference,
} from "./preferences";

const IMAGE = { name: "sky.webp", dataUrl: "data:image/webp;base64,AAAA" };

function memoryStorage(initial?: string) {
  const values = new Map<string, string>(initial ? [[BANNER_KEY, initial]] : []);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

describe("banner preference", () => {
  it("falls back to the default for missing, malformed, unknown or oversized values", () => {
    for (const raw of [
      null,
      "",
      "not json",
      JSON.stringify({ version: 2, selectedId: "none" }),
      JSON.stringify({ version: 1, selectedId: "unknown-art" }),
      JSON.stringify({ version: 1, selectedId: "custom" }),
      JSON.stringify({ version: 1, selectedId: "custom", image: { name: "x", dataUrl: "x" } }),
      JSON.stringify({
        version: 1,
        selectedId: "custom",
        image: { name: "x.svg", dataUrl: "data:image/svg+xml;base64,AAAA" },
      }),
      "x".repeat(MAX_BANNER_CHARACTERS + 2000),
    ])
      expect(parseBannerPreference(raw)).toEqual(DEFAULT_BANNER);
  });

  it("keeps a saved image while built-in art or none is selected", () => {
    const saved = JSON.stringify({ version: 1, selectedId: "moon-shrine", image: IMAGE });
    expect(parseBannerPreference(saved)).toEqual({ selectedId: "moon-shrine", image: IMAGE });
    expect(bannerSource({ selectedId: "none", image: IMAGE })).toBeUndefined();
    expect(bannerSource({ selectedId: "custom", image: IMAGE })).toBe(IMAGE.dataUrl);
    expect(bannerSource({ selectedId: "storm-sky" })).toBe(
      BUILTIN_BANNERS.find((banner) => banner.id === "storm-sky")?.src,
    );
  });

  it("saves choices, tells listeners, and reports a choice it could not save", () => {
    const storage = memoryStorage();
    const store = createBannerStore(storage);
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    expect(store.getSnapshot().preference).toEqual(DEFAULT_BANNER);
    expect(store.set({ selectedId: "custom", image: IMAGE })).toBe(true);
    expect(JSON.parse(storage.values.get(BANNER_KEY) ?? "{}")).toEqual({
      version: 1,
      selectedId: "custom",
      image: IMAGE,
    });
    // "custom" with no image cannot be stored; the store says so instead of pretending.
    expect(store.set({ selectedId: "custom" })).toBe(false);
    expect(store.getSnapshot().saved).toBe(false);
    expect(notified).toBe(2);
    unsubscribe();

    storage.values.set(BANNER_KEY, JSON.stringify({ version: 1, selectedId: "none" }));
    store.reload();
    expect(store.getSnapshot()).toEqual({ preference: { selectedId: "none" }, saved: true });
    expect(notified).toBe(2);
  });
});
