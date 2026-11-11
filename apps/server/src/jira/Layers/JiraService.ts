/**
 * JiraServiceLive - A Jira Cloud connection backed by the server secret store.
 *
 * The site, email and API token are one secret-store entry: a 0600 file in this app's data home,
 * so Stable and Beta never share a connection. The token is sent only to the saved
 * `*.atlassian.net` site and is never returned to a client. Issues are read on demand.
 *
 * @module jira/Layers/JiraService
 */
import {
  JIRA_ISSUE_COMMENT_LIMIT,
  JIRA_ISSUE_LIST_LIMIT,
  JIRA_SEARCH_QUERY_MAX_LENGTH,
  type JiraIssueComment,
  type JiraIssueDetail,
  type JiraIssueSummary,
  type JiraStatus,
  type JiraStatusCategory,
} from "@synara/contracts";
import { Effect, Layer } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { cleanJiraText, jiraDocumentToText } from "../jiraText.ts";
import { JiraError, JiraService, type JiraServiceShape } from "../Services/JiraService.ts";

export const JIRA_CONNECTION_SECRET_NAME = "jira-connection";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_CHARS = 2_000_000;
const MAX_NAME_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_COMMENT_CHARS = 4_000;

// Cloud tenants only: the token must never be sent to a caller-chosen host or path.
const SITE_PATTERN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net\/?$/i;
const EMAIL_PATTERN = /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

interface JiraConnection {
  readonly site: string;
  readonly email: string;
  readonly token: string;
}

export interface JiraSecrets {
  readonly get: (name: string) => Effect.Effect<Uint8Array | null, unknown>;
  readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, unknown>;
  readonly remove: (name: string) => Effect.Effect<void, unknown>;
}

/** The part of `fetch` the service uses, so tests can supply one without the runtime's extras. */
export type JiraFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface JiraServiceDependencies {
  readonly secrets: JiraSecrets;
  readonly fetch?: JiraFetch;
  readonly timeoutMs?: number;
}

const NOT_CONNECTED: JiraStatus = {
  connected: false,
  site: null,
  email: null,
  accountDisplayName: null,
  message: null,
};

const notConnected = () =>
  new JiraError("JIRA_NOT_CONNECTED", "Jira is not connected. Connect it in Settings.");
const unavailable = () =>
  new JiraError("JIRA_UNAVAILABLE", "Could not reach Jira. Check your connection and try again.");

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown, max = MAX_NAME_CHARS): string {
  return cleanJiraText(typeof value === "string" ? value : "", max)
    .replace(/\s+/g, " ")
    .trim();
}

function asIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function statusCategory(value: unknown): JiraStatusCategory {
  const key = asRecord(asRecord(value).statusCategory).key;
  return key === "new"
    ? "todo"
    : key === "indeterminate"
      ? "inProgress"
      : key === "done"
        ? "done"
        : "unknown";
}

/** The site in one canonical form, or null when it is not a Jira Cloud address. */
export function normalizeJiraSite(site: string): string | null {
  const trimmed = site.trim();
  return SITE_PATTERN.test(trimmed) ? trimmed.toLowerCase().replace(/\/$/, "") : null;
}

/** JQL for one list. Free text is quoted; an issue key matches that issue alone. */
export function buildJiraIssuesJql(scope: "assigned" | "recent", query?: string): string {
  const base =
    scope === "assigned"
      ? { where: "assignee = currentUser() AND statusCategory != Done", order: "updated DESC" }
      : { where: "issuekey in issueHistory()", order: "lastViewed DESC" };
  const text = (query ?? "").trim().slice(0, JIRA_SEARCH_QUERY_MAX_LENGTH);
  if (!text) return `${base.where} ORDER BY ${base.order}`;
  const key = text.toUpperCase();
  if (ISSUE_KEY_PATTERN.test(key)) return `issuekey = "${key}"`;
  const quoted = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${base.where} AND text ~ "${quoted}" ORDER BY ${base.order}`;
}

function summaryOf(value: unknown, site: string): JiraIssueSummary | null {
  const issue = asRecord(value);
  const key = typeof issue.key === "string" ? issue.key : "";
  if (!ISSUE_KEY_PATTERN.test(key)) return null;
  const fields = asRecord(issue.fields);
  const assignee = asText(asRecord(fields.assignee).displayName);
  return {
    key,
    summary: asText(fields.summary),
    url: `${site}/browse/${key}`,
    status: asText(asRecord(fields.status).name),
    statusCategory: statusCategory(fields.status),
    type: asText(asRecord(fields.issuetype).name),
    assignee: assignee || null,
    updatedAt: asIsoDate(fields.updated),
  };
}

export const makeJiraService = (dependencies: JiraServiceDependencies): JiraServiceShape => {
  const doFetch: JiraFetch = dependencies.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const readConnection = async (): Promise<JiraConnection | null> => {
    const bytes = await Effect.runPromise(dependencies.secrets.get(JIRA_CONNECTION_SECRET_NAME));
    if (!bytes) return null;
    const saved = asRecord(JSON.parse(new TextDecoder().decode(bytes)));
    const site = typeof saved.site === "string" ? normalizeJiraSite(saved.site) : null;
    if (!site || typeof saved.email !== "string" || typeof saved.token !== "string") return null;
    return { site, email: saved.email, token: saved.token };
  };

  const requireConnection = async (): Promise<JiraConnection> => {
    let connection: JiraConnection | null;
    try {
      connection = await readConnection();
    } catch {
      throw new JiraError(
        "JIRA_UNAVAILABLE",
        "Could not read the saved Jira connection. Reconnect Jira in Settings.",
      );
    }
    if (!connection) throw notConnected();
    return connection;
  };

  const request = async (
    connection: JiraConnection,
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const authorization = Buffer.from(`${connection.email}:${connection.token}`).toString("base64");
    let response: Response;
    let text: string;
    try {
      response = await doFetch(`${connection.site}/rest/api/3/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${authorization}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // A redirect could carry the Authorization header to another host.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = response.ok ? await response.text() : "";
    } catch {
      throw unavailable();
    }
    if (response.status === 401)
      throw new JiraError(
        "JIRA_AUTH",
        "Jira rejected the email or API token. Check them and connect again.",
      );
    if (response.status === 403)
      throw new JiraError("JIRA_FORBIDDEN", "Your Jira account does not have permission for this.");
    if (response.status === 404)
      throw new JiraError(
        "JIRA_NOT_FOUND",
        "That Jira issue does not exist or is not visible to you.",
      );
    if (response.status === 429)
      throw new JiraError(
        "JIRA_RATE_LIMITED",
        "Jira is rate limiting requests. Try again shortly.",
      );
    if (!response.ok || text.length > MAX_RESPONSE_CHARS) throw unavailable();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw unavailable();
    }
  };

  const accountName = async (connection: JiraConnection): Promise<string> =>
    asText(asRecord(await request(connection, "myself")).displayName);

  const run = <A>(operation: () => Promise<A>): Effect.Effect<A, JiraError> =>
    Effect.tryPromise({
      try: operation,
      catch: (cause) => (cause instanceof JiraError ? cause : unavailable()),
    });

  const status: JiraServiceShape["status"] = () =>
    Effect.promise(async (): Promise<JiraStatus> => {
      let connection: JiraConnection | null;
      try {
        connection = await readConnection();
      } catch {
        return { ...NOT_CONNECTED, message: "Could not read the saved Jira connection." };
      }
      if (!connection) return NOT_CONNECTED;
      const identity = { site: connection.site, email: connection.email };
      try {
        const accountDisplayName = await accountName(connection);
        return { connected: true, ...identity, accountDisplayName, message: null };
      } catch (cause) {
        const message = cause instanceof JiraError ? cause.message : unavailable().message;
        return { connected: false, ...identity, accountDisplayName: null, message };
      }
    });

  return {
    status,
    connect: (input) =>
      run(async () => {
        const site = normalizeJiraSite(input.site);
        if (!site)
          throw new JiraError(
            "JIRA_INVALID_INPUT",
            "Enter your Jira Cloud address, like https://your-team.atlassian.net.",
          );
        const email = input.email.trim();
        const token = input.token.trim();
        if (!EMAIL_PATTERN.test(email) || email.length > 254)
          throw new JiraError("JIRA_INVALID_INPUT", "Enter the email of your Atlassian account.");
        if (!TOKEN_PATTERN.test(token))
          throw new JiraError("JIRA_INVALID_INPUT", "Enter an Atlassian API token.");
        const connection: JiraConnection = { site, email, token };
        // Prove the credentials first: a failed check must not replace a working connection.
        const accountDisplayName = await accountName(connection);
        try {
          await Effect.runPromise(
            dependencies.secrets.set(
              JIRA_CONNECTION_SECRET_NAME,
              new TextEncoder().encode(JSON.stringify(connection)),
            ),
          );
        } catch {
          throw new JiraError("JIRA_UNAVAILABLE", "Could not save the Jira connection.");
        }
        return { connected: true, site, email, accountDisplayName, message: null };
      }),
    disconnect: () =>
      run(async () => {
        try {
          await Effect.runPromise(dependencies.secrets.remove(JIRA_CONNECTION_SECRET_NAME));
        } catch {
          throw new JiraError("JIRA_UNAVAILABLE", "Could not remove the Jira connection.");
        }
        return NOT_CONNECTED;
      }),
    issues: (input) =>
      run(async () => {
        const connection = await requireConnection();
        const result = asRecord(
          await request(connection, "search/jql", {
            jql: buildJiraIssuesJql(input.scope, input.query),
            maxResults: JIRA_ISSUE_LIST_LIMIT,
            fields: ["summary", "status", "issuetype", "assignee", "updated"],
          }),
        );
        const rows = Array.isArray(result.issues) ? result.issues : [];
        return {
          issues: rows
            .slice(0, JIRA_ISSUE_LIST_LIMIT)
            .flatMap((row) => summaryOf(row, connection.site) ?? []),
        };
      }),
    issue: (input) =>
      run(async (): Promise<JiraIssueDetail> => {
        const key = input.key.trim().toUpperCase();
        if (!ISSUE_KEY_PATTERN.test(key) || key.length > 100)
          throw new JiraError("JIRA_INVALID_INPUT", "That is not a Jira issue key.");
        const connection = await requireConnection();
        const raw = await request(
          connection,
          `issue/${key}?fields=summary,status,issuetype,assignee,updated,description`,
        );
        const summary = summaryOf(raw, connection.site);
        if (!summary)
          throw new JiraError(
            "JIRA_NOT_FOUND",
            "That Jira issue does not exist or is not visible to you.",
          );
        const page = asRecord(
          await request(
            connection,
            `issue/${key}/comment?maxResults=${JIRA_ISSUE_COMMENT_LIMIT}&orderBy=-created`,
          ),
        );
        const rows = Array.isArray(page.comments) ? page.comments : [];
        const comments = rows.slice(0, JIRA_ISSUE_COMMENT_LIMIT).map((row): JiraIssueComment => {
          const comment = asRecord(row);
          return {
            author: asText(asRecord(comment.author).displayName),
            updatedAt: asIsoDate(comment.updated ?? comment.created),
            body: jiraDocumentToText(comment.body, MAX_COMMENT_CHARS),
          };
        });
        const total = typeof page.total === "number" ? page.total : comments.length;
        return {
          ...summary,
          description: jiraDocumentToText(
            asRecord(asRecord(raw).fields).description,
            MAX_DESCRIPTION_CHARS,
          ),
          comments,
          commentsTruncated: total > comments.length,
        };
      }),
  };
};

export const JiraServiceLive = Layer.effect(
  JiraService,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    return makeJiraService({ secrets });
  }),
);
