// FILE: EnvironmentToggle.tsx
// Purpose: The single chat-header "Environment" button that replaces the former
//          Open-in-editor + git-actions + diff-toggle cluster. It toggles the Environment
//          panel overlay, which is always pinned to the top-right of the chat column
//          (with matching p-3 gutters). When the right dock is closed the overlay also
//          reserves transcript/composer inset; when the dock is open it overlays only.
// Layer: Chat header control

import { EnvironmentPanelIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { Toggle } from "../../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { CHAT_HEADER_TOGGLE_CLASS_NAME, SurfaceChipIcon } from "../chatHeaderControls";
import { useTranslation } from "~/i18n";

export interface EnvironmentToggleState {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// A square tile, as in Codex: while the panel is open the tile is filled and the glyph is at
// full ink, so the button reads as "on" beside the plain header icons.
const TOGGLE_CLASS_NAME = cn(
  CHAT_HEADER_TOGGLE_CLASS_NAME,
  "!size-8 rounded-lg [&_svg,&_[data-slot=central-icon]]:mx-0",
  "data-pressed:bg-[color-mix(in_srgb,var(--foreground)_10%,transparent)]",
);

export function EnvironmentToggle({ environment }: { environment: EnvironmentToggleState }) {
  const { t } = useTranslation();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            className={TOGGLE_CLASS_NAME}
            pressed={environment.open}
            onPressedChange={environment.onOpenChange}
            aria-label={t("chat:environment_togglePanel")}
            variant="default"
            size="xs"
          >
            <SurfaceChipIcon
              icon={EnvironmentPanelIcon}
              className="size-5 in-data-pressed:opacity-100"
            />
          </Toggle>
        }
      />
      <TooltipPopup side="bottom">{t("chat:general_environmentPanel")}</TooltipPopup>
    </Tooltip>
  );
}
