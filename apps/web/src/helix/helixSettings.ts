// FILE: helixSettings.ts
// Purpose: Flip the server's `enableHelix` setting (the master switch) from Settings or
//          from the composer's first-use prompt, through the existing settings update.
// Layer: Web Helix data
// Exports: updateHelixSetting

import type { QueryClient } from "@tanstack/react-query";

import { t } from "~/i18n";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import { toastManager } from "~/components/ui/toast";

/** Saves `enableHelix`; returns whether it was saved. A failure toasts and refetches. */
export async function updateHelixSetting(
  queryClient: QueryClient,
  next: boolean,
): Promise<boolean> {
  try {
    const saved = await ensureNativeApi().server.updateSettings({ enableHelix: next });
    queryClient.setQueryData(serverQueryKeys.settings(), saved);
    return true;
  } catch (error) {
    toastManager.add({
      type: "error",
      title: t("settings:helix_couldNotUpdateSetting"),
      description: error instanceof Error ? error.message : undefined,
    });
    await queryClient
      .invalidateQueries({ queryKey: serverQueryKeys.settings() })
      .catch(() => undefined);
    return false;
  }
}
