// FILE: HelixSetting.tsx
// Purpose: Opt into Helix (a chat's agent as Lead, a Builder agent implementing in the
//          same worktree). Off by default; while off nothing Helix-related renders.
//          Shown only when the connected server offers Helix.

import { WS_HELIX_PAIRS_CAPABILITY } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useTranslation } from "~/i18n";
import { serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import { onNativeApiServerCapabilitiesChange, readNativeApiServerCapability } from "~/nativeApi";
import { helixErrorMessageKey } from "~/helix/helixErrors";
import { useHelixStore } from "~/helix/helixStore";
import { updateHelixSetting } from "~/helix/helixSettings";
import { loadHelixCapabilities } from "~/helix/helixSync";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./SettingsPanelPrimitives";

const subscribe = (listener: () => void) => onNativeApiServerCapabilitiesChange(listener);
const readCapability = () => readNativeApiServerCapability(WS_HELIX_PAIRS_CAPABILITY);
const unavailable = () => false;

export function HelixSetting() {
  const { t } = useTranslation();
  const supported = useSyncExternalStore(subscribe, readCapability, unavailable);
  const queryClient = useQueryClient();
  const settings = useQuery(serverSettingsQueryOptions());
  const capabilitiesError = useHelixStore((state) => state.capabilitiesError);
  const mutationInFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const enabled = settings.data?.enableHelix === true;

  // The probe says whether this server can actually run pairs (it may lack the service).
  useEffect(() => {
    if (supported && enabled) void loadHelixCapabilities();
  }, [enabled, supported]);

  if (!supported) return null;

  const update = async (next: boolean) => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setPending(true);
    try {
      await updateHelixSetting(queryClient, next);
    } finally {
      mutationInFlight.current = false;
      setPending(false);
    }
  };

  return (
    <SettingsRow
      id="setting-helix"
      title="settings:helix_settingTitle"
      description="settings:helix_settingDescription"
      status={
        enabled && capabilitiesError !== null ? (
          <span role="status">{t(helixErrorMessageKey(capabilitiesError))}</span>
        ) : undefined
      }
      control={
        <Switch
          checked={enabled}
          disabled={!settings.data || pending}
          onCheckedChange={(checked) => void update(Boolean(checked))}
          aria-label={t("settings:helix_settingTitle")}
        />
      }
    />
  );
}
