// FILE: JiraConnectionSettings.tsx
// Purpose: The Jira Cloud connection in Settings: whether it is connected and as whom, a short
//   form (site, email, API token) to connect, and a way to disconnect. The token is write-only:
//   it is sent to the server once and never read back.
// Layer: Settings presentation
// Depends on: jiraQueryOptions, the shared settings primitives, Input and Button.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { useTranslation } from "~/i18n";
import {
  jiraConnectMutationOptions,
  jiraDisconnectMutationOptions,
  jiraStatusQueryOptions,
} from "~/lib/jiraQueryOptions";
import { ensureNativeApi } from "~/nativeApi";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

export function JiraConnectionSettings(props: { active: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const statusQuery = useQuery(jiraStatusQueryOptions({ enabled: props.active }));
  const [formOpen, setFormOpen] = useState(false);
  const [site, setSite] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");

  const connectMutation = useMutation({
    ...jiraConnectMutationOptions(queryClient),
    onSuccess: (status) => {
      queryClient.setQueryData(jiraStatusQueryOptions().queryKey, status);
      setToken("");
      setFormOpen(false);
      toastManager.add({ type: "success", title: t("settings:jiraConnected") });
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: t("settings:couldNotConnectJira"),
        description: error instanceof Error ? error.message : t("chat:tryAgain"),
      }),
  });
  const disconnectMutation = useMutation({
    ...jiraDisconnectMutationOptions(queryClient),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: t("settings:couldNotDisconnectJira"),
        description: error instanceof Error ? error.message : t("chat:tryAgain"),
      }),
  });

  if (!props.active) return null;

  const status = statusQuery.data;
  const connected = status?.connected === true;
  const description = connected
    ? t("settings:jiraConnectedAs", {
        site: status.site?.replace(/^https:\/\//, "") ?? "",
        name: status.accountDisplayName || status.email || "",
      })
    : (status?.message ?? t("settings:connectJiraToStartThreadsFromYourTickets"));

  const openForm = () => {
    // A saved connection that stopped working keeps its site and email for the retry.
    setSite(status?.site ?? "");
    setEmail(status?.email ?? "");
    setToken("");
    setFormOpen(true);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (connectMutation.isPending) return;
    connectMutation.mutate({ site: site.trim(), email: email.trim(), token: token.trim() });
  };
  const disconnect = async () => {
    const confirmed = await ensureNativeApi().dialogs.confirm(t("settings:disconnectJiraConfirm"));
    if (confirmed) disconnectMutation.mutate();
  };
  const canSubmit = site.trim().length > 0 && email.trim().length > 0 && token.trim().length > 0;

  return (
    <SettingsSection title={t("settings:jira")} translateTitle={false}>
      <SettingsRow
        title={t("settings:jiraCloud")}
        description={description}
        control={
          connected ? (
            <Button
              variant="outline"
              disabled={disconnectMutation.isPending}
              onClick={() => {
                void disconnect();
              }}
            >
              {t("settings:disconnect")}
            </Button>
          ) : formOpen ? null : (
            <Button disabled={statusQuery.isPending} onClick={openForm}>
              {t("settings:connect")}
            </Button>
          )
        }
      >
        {formOpen && !connected ? (
          <form className="mt-3 flex max-w-md flex-col gap-2.5" onSubmit={submit}>
            <label className="flex flex-col gap-1 text-ui-sm text-muted-foreground">
              {t("settings:jiraSiteAddress")}
              <Input
                type="url"
                autoComplete="off"
                placeholder="https://your-team.atlassian.net"
                maxLength={255}
                value={site}
                onChange={(event) => setSite(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-ui-sm text-muted-foreground">
              {t("settings:email")}
              <Input
                type="email"
                autoComplete="off"
                placeholder={t("settings:jiraEmailPlaceholder")}
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1 text-ui-sm text-muted-foreground">
              {t("settings:apiToken")}
              <Input
                type="password"
                autoComplete="off"
                maxLength={4096}
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <p className="text-ui-xs text-muted-foreground">{t("settings:jiraTokenHelp")}</p>
            <div className="flex gap-2">
              <Button type="submit" disabled={!canSubmit || connectMutation.isPending}>
                {t("settings:connectJira")}
              </Button>
              <Button type="button" variant="outline" onClick={() => setFormOpen(false)}>
                {t("common:form_cancel")}
              </Button>
            </div>
          </form>
        ) : null}
      </SettingsRow>
    </SettingsSection>
  );
}
