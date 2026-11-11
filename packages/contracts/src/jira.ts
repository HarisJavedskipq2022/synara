import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";

// A native Jira Cloud connection: the user's own site, email and API token. The token stays on the
// server (in its secret store) and is never returned to a client; issues are read on demand and
// are not persisted.

/** How many issues one list returns. */
export const JIRA_ISSUE_LIST_LIMIT = 50;
/** How many comments an issue detail carries, newest first. */
export const JIRA_ISSUE_COMMENT_LIMIT = 20;
export const JIRA_SEARCH_QUERY_MAX_LENGTH = 200;

export const JiraConnectInput = Schema.Struct({
  /** `https://<name>.atlassian.net`. Only Jira Cloud sites are accepted. */
  site: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  /** An Atlassian API token. Write-only: no result ever carries it. */
  token: TrimmedNonEmptyString,
});
export type JiraConnectInput = typeof JiraConnectInput.Type;

export const JiraStatus = Schema.Struct({
  connected: Schema.Boolean,
  site: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  /** The account's name as Jira reports it, when the saved credentials still work. */
  accountDisplayName: Schema.NullOr(Schema.String),
  /** Why a saved connection is not usable right now. Null when connected or never set up. */
  message: Schema.NullOr(Schema.String),
});
export type JiraStatus = typeof JiraStatus.Type;

/** `assigned`: open issues assigned to the user. `recent`: issues the user viewed lately. */
export const JiraIssueScope = Schema.Literals(["assigned", "recent"]);
export type JiraIssueScope = typeof JiraIssueScope.Type;

export const JiraIssuesInput = Schema.Struct({
  scope: JiraIssueScope,
  /** Free text matched against issue text; an issue key such as `SHP-12` matches that issue. */
  query: Schema.optional(Schema.String),
});
export type JiraIssuesInput = typeof JiraIssuesInput.Type;

export const JiraStatusCategory = Schema.Literals(["todo", "inProgress", "done", "unknown"]);
export type JiraStatusCategory = typeof JiraStatusCategory.Type;

const jiraIssueSummaryFields = {
  /** `SHP-4253`. */
  key: TrimmedNonEmptyString,
  summary: Schema.String,
  /** The issue's page on the connected site. */
  url: TrimmedNonEmptyString,
  status: Schema.String,
  statusCategory: JiraStatusCategory,
  type: Schema.String,
  assignee: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(IsoDateTime),
} as const;

export const JiraIssueSummary = Schema.Struct(jiraIssueSummaryFields);
export type JiraIssueSummary = typeof JiraIssueSummary.Type;

export const JiraIssuesResult = Schema.Struct({
  issues: Schema.Array(JiraIssueSummary),
});
export type JiraIssuesResult = typeof JiraIssuesResult.Type;

export const JiraIssueInput = Schema.Struct({
  key: TrimmedNonEmptyString,
});
export type JiraIssueInput = typeof JiraIssueInput.Type;

export const JiraIssueComment = Schema.Struct({
  author: Schema.String,
  updatedAt: Schema.NullOr(IsoDateTime),
  /** Plain text converted from Jira's document format. Untrusted. */
  body: Schema.String,
});
export type JiraIssueComment = typeof JiraIssueComment.Type;

export const JiraIssueDetail = Schema.Struct({
  ...jiraIssueSummaryFields,
  /** Plain text converted from Jira's document format. Untrusted. */
  description: Schema.String,
  /** Newest first. */
  comments: Schema.Array(JiraIssueComment),
  commentsTruncated: Schema.Boolean,
});
export type JiraIssueDetail = typeof JiraIssueDetail.Type;
