// FILE: preferences.ts
// Purpose: The device-local activity banner choice: which artwork shows under the Environment
//          card, and the user's own image when they picked one.
// Layer: Chat shell state (localStorage)
// Exports: banner preference types, parsing, the shared store, and image preparation
//
// Ported from Arbor Classic's features/thread/banners/preferences.ts.

import { BUILTIN_BANNERS, type BuiltinBannerId } from "./builtins";

export const BANNER_KEY = "arbor.banner.v1";
// Includes the data URL prefix and base64 overhead; the saved copy stays below about 1.1 MB.
export const MAX_BANNER_CHARACTERS = 1_500_000;
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 48_000_000;
const IMAGE_DATA_URL = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/;

export type BannerId = BuiltinBannerId | "none" | "custom";
export interface BannerImage {
  readonly name: string;
  readonly dataUrl: string;
}
export interface BannerPreference {
  readonly selectedId: BannerId;
  readonly image?: BannerImage;
}
export const DEFAULT_BANNER: BannerPreference = { selectedId: "crimson-dusk" };

/** Why an image could not be used. Each maps to a `chat:banner_error_*` message. */
export type BannerErrorCode = "notImage" | "tooLarge" | "unreadable" | "tooDetailed" | "notSaved";
export class BannerError extends Error {
  override readonly name = "BannerError";
  readonly code: BannerErrorCode;
  constructor(code: BannerErrorCode) {
    super(code);
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseImage(value: unknown): BannerImage {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.dataUrl !== "string" ||
    value.dataUrl.length > MAX_BANNER_CHARACTERS ||
    !IMAGE_DATA_URL.test(value.dataUrl)
  )
    throw new Error("Invalid banner image.");
  return { name: value.name.slice(0, 120), dataUrl: value.dataUrl };
}

function parseValue(value: unknown): BannerPreference {
  if (!isRecord(value) || value.version !== 1) throw new Error("Invalid banner preference.");
  const builtin = BUILTIN_BANNERS.find((banner) => banner.id === value.selectedId)?.id;
  if (!builtin && value.selectedId !== "none" && value.selectedId !== "custom")
    throw new Error("Unknown banner.");
  const selectedId: BannerId = builtin ?? (value.selectedId === "none" ? "none" : "custom");
  if (value.image === undefined) {
    if (selectedId === "custom") throw new Error("Missing banner image.");
    return { selectedId };
  }
  return { selectedId, image: parseImage(value.image) };
}

export function parseBannerPreference(raw: string | null): BannerPreference {
  try {
    // Bound before parsing potentially untrusted device storage.
    if (!raw || raw.length > MAX_BANNER_CHARACTERS + 1024) return DEFAULT_BANNER;
    return parseValue(JSON.parse(raw));
  } catch {
    return DEFAULT_BANNER;
  }
}

type BannerStorage = Pick<Storage, "getItem" | "setItem">;

function readBannerPreference(storage: Pick<Storage, "getItem">): BannerPreference {
  try {
    return parseBannerPreference(storage.getItem(BANNER_KEY));
  } catch {
    return DEFAULT_BANNER;
  }
}

function saveBannerPreference(
  preference: BannerPreference,
  storage: Pick<Storage, "setItem">,
): boolean {
  try {
    const parsed = parseValue({ version: 1, ...preference });
    storage.setItem(BANNER_KEY, JSON.stringify({ version: 1, ...parsed }));
    return true;
  } catch {
    return false;
  }
}

export function bannerSource(preference: BannerPreference): string | undefined {
  if (preference.selectedId === "none") return undefined;
  if (preference.selectedId === "custom") return preference.image?.dataUrl;
  return BUILTIN_BANNERS.find((banner) => banner.id === preference.selectedId)?.src;
}

/**
 * A resized copy of the chosen file, small enough to keep in device storage. The column is
 * narrow but tall and a landscape image covers it by height, so up to 4K rows are kept.
 */
export async function bannerFromFile(file: File): Promise<BannerImage> {
  if (!file.type.startsWith("image/")) throw new BannerError("notImage");
  if (file.size > MAX_SOURCE_BYTES) throw new BannerError("tooLarge");
  const image = await createImageBitmap(file).catch(() => {
    throw new BannerError("unreadable");
  });
  try {
    if (!image.width || !image.height || image.width * image.height > MAX_SOURCE_PIXELS)
      throw new BannerError("tooLarge");
    const fit = Math.min(1, 3840 / image.width, 2160 / image.height);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new BannerError("unreadable");
    // Keep every pixel the limits allow; give up quality, then size, only when the copy is too big.
    for (const scale of [fit, fit * 0.75, fit * 0.5]) {
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.82, 0.6]) {
        const dataUrl = canvas.toDataURL("image/webp", quality);
        if (IMAGE_DATA_URL.test(dataUrl) && dataUrl.length <= MAX_BANNER_CHARACTERS)
          return { name: file.name.slice(0, 120), dataUrl };
      }
    }
    throw new BannerError("tooDetailed");
  } finally {
    image.close();
  }
}

/** One device-local preference shared by the banner's own menu and Settings → Appearance. */
export function createBannerStore(storage: BannerStorage) {
  let state = { preference: readBannerPreference(storage), saved: true };
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reload: () => {
      state = { preference: readBannerPreference(storage), saved: true };
      emit();
    },
    set: (preference: BannerPreference) => {
      const saved = saveBannerPreference(preference, storage);
      state = { preference, saved };
      emit();
      return saved;
    },
  };
}

let store: ReturnType<typeof createBannerStore> | undefined;
export function activityBannerStore() {
  store ??= createBannerStore({
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
  });
  return store;
}
