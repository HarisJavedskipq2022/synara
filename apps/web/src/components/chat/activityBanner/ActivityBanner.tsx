// FILE: ActivityBanner.tsx
// Purpose: Decorative artwork filling the column under the docked Environment card, down to
//          the composer's bottom edge. Its own menu switches the artwork or hides it.
// Layer: Chat shell component
// Exports: ActivityBanner
//
// Ported from Arbor Classic's features/thread/banners/ActivityBanner.tsx.

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { RAISED_SURFACE_BORDER_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { IconButton } from "~/components/ui/icon-button";
import { Menu, MenuGroup, MenuItem, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { useTranslation } from "~/i18n";
import { BannerImageIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { BUILTIN_BANNERS } from "./builtins";
import { bannerSource } from "./preferences";
import { useBannerControls } from "./useBannerControls";

export function ActivityBanner({ className }: { className?: string }) {
  const { t } = useTranslation();
  const controls = useBannerControls();
  const src = bannerSource(controls.preference);
  if (!src) return null;
  return (
    <div
      data-activity-banner=""
      className={cn(
        "group/banner pointer-events-auto relative isolate min-h-44 w-72 flex-1 overflow-hidden rounded-2xl border",
        RAISED_SURFACE_BORDER_CLASS_NAME,
        className,
      )}
    >
      <img
        src={src}
        alt=""
        aria-hidden="true"
        className={cn(
          "absolute inset-0 size-full object-cover object-[center_25%]",
          // The built-in art is drawn for a dark shell; soften it on a light one.
          controls.preference.selectedId !== "custom" && "opacity-45 dark:opacity-100",
        )}
      />
      <div className="absolute top-2 right-2">
        <Menu>
          <IconButton
            render={<MenuTrigger />}
            label={t("chat:banner_change")}
            disabled={controls.loading}
            className="bg-popover/90 text-foreground opacity-0 transition-opacity hover:bg-popover focus-visible:opacity-100 group-focus-within/banner:opacity-100 group-hover/banner:opacity-100 data-popup-open:opacity-100 motion-reduce:transition-none"
          >
            <BannerImageIcon className="size-3.5" />
          </IconButton>
          <ComposerPickerMenuPopup align="end" side="bottom" className="min-w-44">
            <MenuGroup>
              {BUILTIN_BANNERS.map((banner) => (
                <MenuItem key={banner.id} onClick={() => controls.choose(banner.id)}>
                  {t(banner.nameKey)}
                </MenuItem>
              ))}
              {controls.preference.image ? (
                <MenuItem onClick={() => controls.choose("custom")}>
                  {t("chat:banner_yourImage")}
                </MenuItem>
              ) : null}
            </MenuGroup>
            <MenuSeparator />
            <MenuGroup>
              <MenuItem onClick={controls.chooseImage}>{t("chat:banner_chooseImage")}</MenuItem>
              <MenuItem onClick={() => controls.choose("none")}>{t("chat:banner_hide")}</MenuItem>
            </MenuGroup>
          </ComposerPickerMenuPopup>
        </Menu>
      </div>
      {controls.fileInput}
      {controls.error ? (
        <p
          role="alert"
          className="absolute right-2 bottom-2 left-2 m-0 rounded-md bg-popover p-2 text-ui-xs text-destructive"
        >
          {controls.error}
        </p>
      ) : null}
    </div>
  );
}
