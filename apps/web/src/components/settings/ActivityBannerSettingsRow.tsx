// FILE: ActivityBannerSettingsRow.tsx
// Purpose: Appearance row for the artwork under the Environment panel: pick built-in art,
//          the user's own image, or none. The banner's own menu changes the same choice.
// Layer: Settings UI
// Exports: ActivityBannerSettingsRow

import { BUILTIN_BANNERS } from "~/components/chat/activityBanner/builtins";
import { type BannerId, DEFAULT_BANNER } from "~/components/chat/activityBanner/preferences";
import { useBannerControls } from "~/components/chat/activityBanner/useBannerControls";
import { Button } from "~/components/ui/button";
import { SelectItem } from "~/components/ui/select";
import { useTranslation } from "~/i18n";

import { SettingResetButton, SettingsSelectControl } from "./SettingControls";
import { SettingsRow } from "./SettingsPanelPrimitives";

export function ActivityBannerSettingsRow() {
  const { t } = useTranslation();
  const controls = useBannerControls();
  const selectedId = controls.preference.selectedId;
  const options: ReadonlyArray<{ value: BannerId; label: string }> = [
    { value: "none", label: t("settings:activityBannerNone") },
    ...BUILTIN_BANNERS.map((banner) => ({ value: banner.id, label: t(banner.nameKey) })),
    { value: "custom", label: t("chat:banner_yourImage") },
  ];
  return (
    <SettingsRow
      id="setting-activity-banner"
      title="settings:activityBanner"
      description="settings:activityBannerDescription"
      status={
        controls.error ? (
          <span role="alert" className="text-destructive">
            {controls.error}
          </span>
        ) : undefined
      }
      resetAction={
        selectedId !== DEFAULT_BANNER.selectedId ? (
          <SettingResetButton
            label={t("settings:activityBanner")}
            onClick={() => controls.choose(DEFAULT_BANNER.selectedId)}
          />
        ) : null
      }
      control={
        <div className="flex items-center gap-2">
          <SettingsSelectControl
            value={selectedId}
            onValueChange={(next) => {
              const option = options.find((candidate) => candidate.value === next);
              if (option) controls.choose(option.value);
            }}
            ariaLabel={t("settings:activityBanner")}
            valueContent={options.find((option) => option.value === selectedId)?.label}
          >
            {options.map((option) => (
              <SelectItem hideIndicator key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SettingsSelectControl>
          <Button
            variant="outline"
            size="sm"
            disabled={controls.loading}
            onClick={controls.chooseImage}
          >
            {controls.loading
              ? t("settings:activityBannerPreparing")
              : t("settings:activityBannerChoose")}
          </Button>
          {controls.fileInput}
        </div>
      }
    />
  );
}
