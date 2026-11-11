// Query definitions for the Jira connection: its status, the issue lists the composer's ticket
// picker shows, and the connect and disconnect mutations Settings uses.
import type { JiraConnectInput, JiraIssueScope } from "@synara/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "~/nativeApi";

export const jiraQueryKeys = {
  all: ["jira"] as const,
  status: ["jira", "status"] as const,
  issues: (scope: JiraIssueScope) => ["jira", "issues", scope] as const,
};

const JIRA_STATUS_STALE_TIME_MS = 60_000;
const JIRA_ISSUES_STALE_TIME_MS = 30_000;

export function jiraStatusQueryOptions(behavior: { enabled?: boolean } = {}) {
  return queryOptions({
    queryKey: jiraQueryKeys.status,
    queryFn: () => ensureNativeApi().jira.status(),
    enabled: behavior.enabled ?? true,
    staleTime: JIRA_STATUS_STALE_TIME_MS,
  });
}

export function jiraIssuesQueryOptions(
  scope: JiraIssueScope,
  behavior: { enabled?: boolean } = {},
) {
  return queryOptions({
    queryKey: jiraQueryKeys.issues(scope),
    queryFn: () => ensureNativeApi().jira.issues({ scope }),
    enabled: behavior.enabled ?? true,
    staleTime: JIRA_ISSUES_STALE_TIME_MS,
    // A missing connection or a rejected token will not fix itself on a retry.
    retry: false,
  });
}

export const jiraMutationKeys = {
  connect: ["jira", "connect"] as const,
  disconnect: ["jira", "disconnect"] as const,
};

export function jiraConnectMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: jiraMutationKeys.connect,
    networkMode: "always",
    mutationFn: (input: JiraConnectInput) => ensureNativeApi().jira.connect(input),
    onSuccess: (status) => {
      queryClient.setQueryData(jiraQueryKeys.status, status);
      return queryClient.invalidateQueries({ queryKey: jiraQueryKeys.all });
    },
  });
}

export function jiraDisconnectMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationKey: jiraMutationKeys.disconnect,
    networkMode: "always",
    mutationFn: () => ensureNativeApi().jira.disconnect(),
    onSuccess: (status) => {
      queryClient.setQueryData(jiraQueryKeys.status, status);
      return queryClient.invalidateQueries({ queryKey: jiraQueryKeys.all });
    },
  });
}
