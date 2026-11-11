// FILE: useBannerControls.tsx
// Purpose: Read and change the activity banner preference, including picking an image file.
// Layer: Chat shell hook
// Exports: useBannerControls

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useTranslation } from "~/i18n";

import {
  activityBannerStore,
  BANNER_KEY,
  BannerError,
  type BannerErrorCode,
  type BannerId,
  bannerFromFile,
} from "./preferences";

const ERROR_KEYS = {
  notImage: "chat:banner_error_notImage",
  tooLarge: "chat:banner_error_tooLarge",
  unreadable: "chat:banner_error_unreadable",
  tooDetailed: "chat:banner_error_tooDetailed",
  notSaved: "chat:banner_error_notSaved",
} as const satisfies Record<BannerErrorCode, string>;

export function useBannerControls() {
  const { t } = useTranslation();
  const store = activityBannerStore();
  const { preference, saved } = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const input = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<BannerErrorCode | null>(null);

  // Another window changed the choice: follow it.
  useEffect(() => {
    const reload = (event: StorageEvent) => {
      if (event.key === BANNER_KEY || event.key === null) store.reload();
    };
    window.addEventListener("storage", reload);
    return () => window.removeEventListener("storage", reload);
  }, [store]);

  const errorCode = failure ?? (saved ? null : "notSaved");
  const chooseImage = () => input.current?.click();
  const choose = (selectedId: BannerId) => {
    setFailure(null);
    if (selectedId === "custom" && !preference.image) {
      chooseImage();
      return;
    }
    store.set({ ...preference, selectedId });
  };

  return {
    preference,
    loading,
    error: errorCode ? t(ERROR_KEYS[errorCode]) : "",
    choose,
    chooseImage,
    fileInput: (
      <input
        ref={input}
        type="file"
        accept="image/*"
        aria-label={t("chat:banner_imageFile")}
        tabIndex={-1}
        className="sr-only size-px"
        disabled={loading}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          setLoading(true);
          setFailure(null);
          void bannerFromFile(file)
            .then(
              (image) => {
                store.set({ selectedId: "custom", image });
              },
              (cause: unknown) => {
                setFailure(cause instanceof BannerError ? cause.code : "unreadable");
              },
            )
            .finally(() => setLoading(false));
        }}
      />
    ),
  };
}
