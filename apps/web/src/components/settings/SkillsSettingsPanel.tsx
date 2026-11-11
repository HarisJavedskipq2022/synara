// FILE: SkillsSettingsPanel.tsx
// Purpose: Settings → Skills panel. Lists every skill from the unified cross-provider
// catalog (~/.synara/skills plus each provider's skills folder), shows which provider
// a skill comes from, and lets the user enable/disable each one. Disabled skills are
// hidden from the composer skill picker on every provider.

import type { ProviderKind, ServerSettings } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import {
  SettingsListRow,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/SettingsPanelPrimitives";
import { IconButton } from "~/components/ui/icon-button";
import { Switch } from "~/components/ui/switch";
import { ChevronRightIcon, SkillCubeIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import {
  providerDiscoveryQueryKeys,
  skillsCatalogQueryOptions,
} from "~/lib/providerDiscoveryReactQuery";
import { serverQueryKeys, serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import {
  buildSettingsSkillGroups,
  buildSettingsSkillSectionsFromGroups,
  providerDisplayName,
  type SettingsSkillGroup,
  settingsSkillNameKey,
} from "./skillsSettingsModel";
import { useTranslation } from "~/i18n";

function SkillProviderStack({ providers }: { providers: ReadonlyArray<ProviderKind> }) {
  const { t } = useTranslation();

  if (providers.length === 0) {
    return null;
  }

  const label = providers.map(providerDisplayName).join(", ");
  const stackLabel = t("settings:provider", {
    value0: providers.length === 1 ? t("common:copy") : t("settings:copies"),
    value1: label,
  });
  return (
    <span
      className="inline-flex shrink-0 items-center -space-x-1"
      aria-label={stackLabel}
      title={stackLabel}
    >
      {providers.map((provider) => (
        <span
          key={provider}
          className="inline-flex size-4 items-center justify-center rounded-full border border-background bg-background"
        >
          <ProviderIcon provider={provider} className="size-3" />
        </span>
      ))}
    </span>
  );
}

/**
 * One skill as a compact row: icon tile, name and a one-line description, then the providers
 * it comes from, its switch and a chevron. The chevron opens the full description and where
 * each copy lives on disk, which would otherwise make every row several lines tall.
 */
function SkillRow({
  group,
  enabled,
  onEnabledChange,
}: {
  group: SettingsSkillGroup;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsLabel = expanded
    ? t("settings:skills_hideDetails")
    : t("settings:skills_showDetails");
  return (
    <SettingsListRow
      align={expanded ? "start" : "center"}
      leading={
        <span className="flex size-8 items-center justify-center rounded-lg bg-secondary text-foreground">
          <SkillCubeIcon aria-hidden="true" className="size-4" />
        </span>
      }
      title={group.displayName}
      description={
        expanded ? (
          <span className="flex min-w-0 flex-col gap-1">
            <span>{group.description}</span>
            <span className="truncate text-ui-sm text-muted-foreground">
              {group.sources.map((source) => source.originInfo.label).join(" · ")}
            </span>
            {group.sources.map((source) => (
              <code key={source.skill.path} className="break-all text-ui-sm text-muted-foreground">
                {source.skill.path}
              </code>
            ))}
          </span>
        ) : (
          <span className="block truncate">{group.description}</span>
        )
      }
      actions={
        <>
          <SkillProviderStack providers={group.providers} />
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => onEnabledChange(Boolean(checked))}
            aria-label={t("settings:enableTheSkill", { value0: group.displayName })}
          />
          <IconButton
            label={detailsLabel}
            aria-expanded={expanded}
            onClick={() => setExpanded((previous) => !previous)}
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            />
          </IconButton>
        </>
      }
    />
  );
}

export function SkillsSettingsPanel() {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const catalogQuery = useQuery(skillsCatalogQueryOptions());
  const serverSettingsQuery = useQuery(serverSettingsQueryOptions());

  const disabledSkillNames = new Set(
    (serverSettingsQuery.data?.skills.disabled ?? []).map((name) => settingsSkillNameKey(name)),
  );

  const catalogSkills = catalogQuery.data?.skills;
  const skillGroups = useMemo(() => buildSettingsSkillGroups(catalogSkills ?? []), [catalogSkills]);
  const skillSections = useMemo(
    () => buildSettingsSkillSectionsFromGroups(skillGroups),
    [skillGroups],
  );

  const setSkillEnabled = (skillName: string, enabled: boolean) => {
    // Read through the query cache (not the render closure) so rapid toggles
    // build on each other instead of clobbering the previous patch.
    const latestSettings = queryClient.getQueryData<ServerSettings>(serverQueryKeys.settings());
    const currentDisabled = latestSettings?.skills.disabled ?? [...disabledSkillNames];
    const key = settingsSkillNameKey(skillName);
    const next = new Set(currentDisabled.map((name) => settingsSkillNameKey(name)));
    if (enabled) {
      next.delete(key);
    } else {
      next.add(key);
    }
    const disabled = [...next].sort();
    if (latestSettings) {
      // Optimistic flip; a failed patch invalidates back to the server state.
      queryClient.setQueryData(serverQueryKeys.settings(), {
        ...latestSettings,
        skills: { disabled },
      });
    }
    void ensureNativeApi()
      .server.updateSettings({ skills: { disabled } })
      .then((nextSettings) => {
        queryClient.setQueryData(serverQueryKeys.settings(), nextSettings);
        // Composer skill pickers are served filtered by these toggles.
        void queryClient.invalidateQueries({ queryKey: providerDiscoveryQueryKeys.all });
      })
      .catch(() => {
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
      });
  };

  const totalSkills = skillGroups.length;
  const enabledSkills = skillGroups.filter((group) => !disabledSkillNames.has(group.key)).length;
  const synaraSkillsDir = catalogQuery.data?.synaraSkillsDir;

  return (
    <div className="space-y-8">
      <SettingsSection title="settings:skills_portableSkills">
        <SettingsRow
          id="setting-synara-skills-folder"
          title="settings:skills_synaraSkillsFolder"
          description="settings:skillsPlacedHereAreAvailableOnEveryProviderWhen"
          status={
            synaraSkillsDir ? (
              <code className="break-all text-ui-sm text-muted-foreground">{synaraSkillsDir}</code>
            ) : null
          }
          control={
            <span className="text-ui leading-snug font-medium text-muted-foreground">
              {catalogQuery.isLoading
                ? t("settings:skills_scanning")
                : t("settings:skillsEnabledOf", {
                    enabled: enabledSkills,
                    total: totalSkills,
                    count: totalSkills,
                  })}
            </span>
          }
        />
      </SettingsSection>

      {catalogQuery.isError ? (
        <SettingsSection title="common:plugin_skillsSection">
          <SettingsRow
            id="setting-skill-discovery-failed"
            title="settings:skills_discoveryFailed"
            description="settings:synaraCouldNotScanTheSkillFoldersRetryAfter"
          />
        </SettingsSection>
      ) : null}

      {!catalogQuery.isLoading && !catalogQuery.isError && totalSkills === 0 ? (
        <SettingsSection title="common:plugin_skillsSection">
          <SettingsRow
            id="setting-no-skills-found"
            title="common:plugin_noSkillsFound"
            description="settings:addASkillFolderContainingASKILLMdTo"
          />
        </SettingsSection>
      ) : null}

      {skillSections.map((section) => {
        return (
          <SettingsSection key={section.key} title={section.title}>
            {section.groups.map((group) => {
              const enabled = !disabledSkillNames.has(group.key);
              return (
                <SkillRow
                  key={group.key}
                  group={group}
                  enabled={enabled}
                  onEnabledChange={(checked) => setSkillEnabled(group.primarySkill.name, checked)}
                />
              );
            })}
          </SettingsSection>
        );
      })}
    </div>
  );
}
