import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";

import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderKind,
  ProviderModelDescriptor,
} from "@synara/contracts";

import {
  type AppSettings,
  getProviderInstanceOptions,
  resolveSelectableProviderInstanceId,
  useAppSettings,
} from "~/appSettings";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";
import { resolveProviderDiscoveryCwd } from "~/lib/providerDiscovery";
import {
  buildModelSelection,
  buildNextProviderOptions,
  buildProviderOptionPatch,
  type ProviderOptions,
} from "~/providerModelOptions";
import { SettingsRow } from "~/components/settings/SettingsPanelPrimitives";
import { SettingsSelectControl } from "~/components/settings/SettingControls";
import { SelectItem } from "~/components/ui/select";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { getComposerTraitSelection } from "~/components/chat/composerTraits";
import { resolveRuntimeModelDescriptor } from "~/components/chat/runtimeModelCapabilities";
import { cn } from "~/lib/utils";

import {
  modelSelectionsEqual,
  resolveGroupModelCatalogPrefetchProviders,
} from "./groupSettingsDialog.logic";
import { useTranslation } from "~/i18n";

function useGroupModelCatalog(input: {
  readonly selection: ModelSelection;
  readonly selectedProviderInstanceId: ProviderInstanceId;
  readonly projectCwd: string;
  readonly pickerOpen: boolean;
}) {
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  return useProviderModelCatalog({
    selectedProvider: input.selection.provider,
    selectedProviderInstanceId: input.selectedProviderInstanceId,
    discoveryEnabled: input.pickerOpen,
    // Warm discovery for the row's provider so dynamic effort levels are known
    // even when the model picker itself never opens; an open picker warms
    // every visible provider like the composer's does.
    prefetchProviders: resolveGroupModelCatalogPrefetchProviders(
      input.pickerOpen,
      input.selection.provider,
    ),
    cwd: resolveProviderDiscoveryCwd({
      activeThreadWorktreePath: null,
      activeProjectCwd: input.projectCwd.length > 0 ? input.projectCwd : null,
      serverCwd: serverConfigQuery.data?.cwd ?? null,
    }),
    modelHintByProvider: { [input.selection.provider]: input.selection.model },
  });
}

/**
 * Reapply the current effort override on a model change when the new model
 * exposes the same option id and accepts the same value; otherwise drop it.
 */
function carryEffortOverride(input: {
  readonly current: ModelSelection;
  readonly currentRuntimeModel: ProviderModelDescriptor | undefined;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly runtimeModel: ProviderModelDescriptor | undefined;
}): ProviderOptions | undefined {
  const options = input.current.options;
  if (options === undefined) return undefined;
  const optionId = getComposerTraitSelection(
    input.current.provider,
    input.current.model,
    "",
    options,
    input.currentRuntimeModel,
  ).primarySelectDescriptor?.id;
  if (optionId === undefined) return undefined;
  const value = (options as Record<string, unknown>)[optionId];
  if (typeof value !== "string") return undefined;
  const nextTraits = getComposerTraitSelection(
    input.provider,
    input.model,
    "",
    undefined,
    input.runtimeModel,
  );
  if (
    nextTraits.primarySelectDescriptor?.id !== optionId ||
    !nextTraits.effortLevels.some((option) => option.value === value)
  ) {
    return undefined;
  }
  return buildNextProviderOptions(
    input.provider,
    undefined,
    buildProviderOptionPatch(input.provider, optionId, value),
  );
}

// The account a group role runs in: the one its selection names, else the provider's default.
function useSelectionProviderInstanceId(
  settings: AppSettings,
  selection: ModelSelection,
): ProviderInstanceId {
  return useMemo(
    () => resolveSelectableProviderInstanceId(settings, selection.provider, selection.instanceId),
    [settings, selection.instanceId, selection.provider],
  );
}

function UseDefaultLink(props: { readonly disabled: boolean; readonly onClick: () => void }) {
  const { t } = useTranslation();

  return (
    <button
      type="button"
      disabled={props.disabled}
      className={cn(
        "text-ui-sm text-muted-foreground hover:text-foreground",
        props.disabled && "cursor-default opacity-50 hover:text-muted-foreground",
      )}
      onClick={props.onClick}
    >
      {t("workspace:useDefault")}
    </button>
  );
}

/** `settings` is the Settings-panel row; `inline` is a dense label + control line for popovers. */
export type GroupRowLayout = "settings" | "inline";

function GroupRowShell(props: {
  readonly layout: GroupRowLayout;
  readonly title: string;
  readonly description: string;
  readonly control?: ReactNode;
  readonly status?: ReactNode;
}) {
  if (props.layout === "settings") {
    return (
      <SettingsRow
        title={props.title}
        description={props.description}
        {...(props.control !== undefined ? { control: props.control } : {})}
        {...(props.status !== undefined ? { status: props.status } : {})}
      />
    );
  }
  return (
    <div className="flex min-h-8 min-w-0 items-center justify-between gap-3 px-2 py-0.5">
      <span className="shrink-0 text-ui text-muted-foreground" title={props.description}>
        {props.title}
      </span>
      <div className="flex min-w-0 justify-end text-ui">{props.control ?? props.status}</div>
    </div>
  );
}

export function GroupModelRow(props: {
  readonly title: string;
  readonly description: string;
  readonly selection: ModelSelection;
  readonly defaultSelection: ModelSelection | null;
  readonly projectCwd: string;
  readonly onChange: (next: ModelSelection) => void;
  /** Providers the row may not choose, each with the reason the picker shows. */
  readonly providerRestrictions?: Partial<Record<ProviderKind, string>> | undefined;
  readonly disabled?: boolean | undefined;
  readonly layout?: GroupRowLayout | undefined;
}) {
  const layout = props.layout ?? "settings";
  const { settings } = useAppSettings();
  const providerStatuses = useProviderStatusesForLocalConfig();
  const [pickerOpen, setPickerOpen] = useState(false);
  const providerInstances = useMemo(() => getProviderInstanceOptions(settings), [settings]);
  const selectedProviderInstanceId = useSelectionProviderInstanceId(settings, props.selection);
  const {
    modelOptionsByProvider,
    modelOptionsByProviderInstance,
    loadingModelProviders,
    discoveryErrorsByProvider,
    runtimeModelsByProvider,
    runtimeModelsByProviderInstance,
  } = useGroupModelCatalog({
    selection: props.selection,
    selectedProviderInstanceId,
    projectCwd: props.projectCwd,
    pickerOpen,
  });
  const isDefault =
    props.defaultSelection !== null &&
    modelSelectionsEqual(props.selection, props.defaultSelection);

  return (
    <GroupRowShell
      layout={layout}
      title={props.title}
      description={props.description}
      control={
        <div
          className={cn(
            "flex flex-col gap-1",
            layout === "settings"
              ? "w-full items-stretch sm:w-auto sm:items-end"
              : "min-w-0 items-end",
          )}
        >
          <ProviderModelPicker
            compact
            provider={props.selection.provider}
            model={props.selection.model}
            lockedProvider={null}
            providers={providerStatuses}
            modelOptionsByProvider={modelOptionsByProvider}
            modelOptionsByProviderInstance={modelOptionsByProviderInstance}
            providerInstances={providerInstances}
            selectedProviderInstanceId={selectedProviderInstanceId}
            loadingModelProviders={loadingModelProviders}
            discoveryErrorsByProvider={discoveryErrorsByProvider}
            hiddenProviders={settings.hiddenProviders}
            providerOrder={settings.providerOrder}
            {...(props.providerRestrictions
              ? { providerRestrictions: props.providerRestrictions }
              : {})}
            disabled={props.disabled === true}
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onProviderModelChange={(provider, model, instanceId) => {
              const runtimeModel = resolveRuntimeModelDescriptor({
                provider,
                model,
                runtimeModels:
                  runtimeModelsByProviderInstance[instanceId ?? provider] ??
                  ((instanceId ?? provider) === selectedProviderInstanceId
                    ? runtimeModelsByProvider[provider]
                    : undefined),
              });
              const options = carryEffortOverride({
                current: props.selection,
                currentRuntimeModel: resolveRuntimeModelDescriptor({
                  provider: props.selection.provider,
                  model: props.selection.model,
                  runtimeModels: runtimeModelsByProvider[props.selection.provider],
                }),
                provider,
                model,
                runtimeModel,
              });
              props.onChange(
                buildModelSelection(provider, model, options, runtimeModel?.supportsAutoMode, {
                  instanceId: instanceId ?? provider,
                }),
              );
            }}
          />
          {props.defaultSelection && layout === "settings" ? (
            <UseDefaultLink
              disabled={isDefault || props.disabled === true}
              onClick={() => {
                const fallback = props.defaultSelection;
                if (fallback) props.onChange(fallback);
              }}
            />
          ) : null}
        </div>
      }
    />
  );
}

export function GroupEffortRow(props: {
  readonly title: string;
  readonly description: string;
  readonly selection: ModelSelection;
  readonly projectCwd: string;
  readonly onChange: (next: ModelSelection) => void;
  readonly disabled?: boolean | undefined;
  readonly layout?: GroupRowLayout | undefined;
}) {
  const { t } = useTranslation();
  const layout = props.layout ?? "settings";

  const { settings } = useAppSettings();
  const selectedProviderInstanceId = useSelectionProviderInstanceId(settings, props.selection);
  const { runtimeModelsByProvider, selectedProviderModelsLoading } = useGroupModelCatalog({
    selection: props.selection,
    selectedProviderInstanceId,
    projectCwd: props.projectCwd,
    pickerOpen: false,
  });
  const runtimeModel = resolveRuntimeModelDescriptor({
    provider: props.selection.provider,
    model: props.selection.model,
    runtimeModels: runtimeModelsByProvider[props.selection.provider],
  });
  const traits = getComposerTraitSelection(
    props.selection.provider,
    props.selection.model,
    "",
    props.selection.options ?? undefined,
    runtimeModel,
    t,
  );
  const optionId = traits.primarySelectDescriptor?.id ?? null;
  const effortOptions = traits.effortLevels.filter(
    (option) => !traits.promptInjectedValues.includes(option.value),
  );
  const hasOverride =
    optionId !== null &&
    props.selection.options !== undefined &&
    optionId in props.selection.options;

  if (effortOptions.length === 0 || optionId === null) {
    return (
      <GroupRowShell
        layout={layout}
        title={props.title}
        description={props.description}
        status={
          <span className="text-muted-foreground">
            {selectedProviderModelsLoading
              ? t("workspace:checkingEffortSupport")
              : t("workspace:notAvailableFor", { value0: props.selection.model })}
          </span>
        }
      />
    );
  }

  const handleEffortChange = (value: string) => {
    const patch = buildProviderOptionPatch(props.selection.provider, optionId, value);
    const options = buildNextProviderOptions(
      props.selection.provider,
      props.selection.options ?? undefined,
      patch,
    );
    props.onChange(
      buildModelSelection(
        props.selection.provider,
        props.selection.model,
        options,
        "supportsAutoMode" in props.selection ? props.selection.supportsAutoMode : undefined,
        { instanceId: props.selection.instanceId },
      ),
    );
  };

  const handleUseDefault = () => {
    const options = props.selection.options;
    if (!options || !(optionId in options)) return;
    const nextOptions = { ...(options as Record<string, unknown>) };
    delete nextOptions[optionId];
    props.onChange(
      buildModelSelection(
        props.selection.provider,
        props.selection.model,
        Object.keys(nextOptions).length > 0 ? (nextOptions as typeof options) : undefined,
        "supportsAutoMode" in props.selection ? props.selection.supportsAutoMode : undefined,
        { instanceId: props.selection.instanceId },
      ),
    );
  };

  const currentEffort = traits.effort ?? effortOptions[0]!.value;
  const currentLabel =
    effortOptions.find((option) => option.value === currentEffort)?.label ?? currentEffort;

  return (
    <GroupRowShell
      layout={layout}
      title={props.title}
      description={props.description}
      control={
        <div
          className={cn(
            "flex flex-col gap-1",
            layout === "settings" ? "w-full items-stretch sm:w-auto sm:items-end" : "items-end",
          )}
        >
          <SettingsSelectControl
            {...(layout === "inline"
              ? {
                  triggerClassName:
                    "h-7 w-auto min-w-0 border-transparent bg-transparent px-1.5 text-ui-sm text-[var(--color-text-foreground-secondary)] shadow-none hover:bg-[var(--color-background-elevated-secondary)] hover:text-[var(--color-text-foreground)] dark:bg-transparent",
                }
              : {})}
            value={currentEffort}
            disabled={props.disabled === true}
            onValueChange={handleEffortChange}
            ariaLabel={props.title}
            valueContent={currentLabel}
          >
            {effortOptions.map((option) => (
              <SelectItem key={option.value} value={option.value} hideIndicator>
                {option.label}
              </SelectItem>
            ))}
          </SettingsSelectControl>
          {layout === "settings" ? (
            <UseDefaultLink
              disabled={!hasOverride || props.disabled === true}
              onClick={handleUseDefault}
            />
          ) : null}
        </div>
      }
    />
  );
}
