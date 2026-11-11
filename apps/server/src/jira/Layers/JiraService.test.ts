import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { jiraDocumentToText } from "../jiraText.ts";
import { JiraError } from "../Services/JiraService.ts";
import {
  buildJiraIssuesJql,
  JIRA_CONNECTION_SECRET_NAME,
  type JiraFetch,
  makeJiraService,
  normalizeJiraSite,
} from "./JiraService.ts";

const SITE = "https://team.atlassian.net";
const CONNECTION = { site: SITE, email: "dana@example.test", token: "secret-token" };
const AUTH = `Basic ${Buffer.from("dana@example.test:secret-token").toString("base64")}`;

const paragraph = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const ISSUE = {
  key: "SHP-4253",
  fields: {
    summary: "  FedEx label\ntimes out ",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    issuetype: { name: "Bug" },
    assignee: { displayName: "Dana" },
    updated: "2026-11-08T12:00:00.000+0000",
    description: paragraph("Large orders time out."),
  },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function harness(saved: typeof CONNECTION | null = CONNECTION) {
  const store = new Map<string, Uint8Array>();
  if (saved)
    store.set(JIRA_CONNECTION_SECRET_NAME, new TextEncoder().encode(JSON.stringify(saved)));
  const requests: { url: URL; init: RequestInit }[] = [];
  const routes = new Map<string, () => Response>([
    ["myself", () => json({ displayName: "Dana" })],
    ["search/jql", () => json({ issues: [ISSUE, { key: "not a key" }] })],
    ["issue/SHP-4253", () => json(ISSUE)],
    [
      "issue/SHP-4253/comment",
      () =>
        json({
          total: 3,
          comments: [
            {
              author: { displayName: "Kai" },
              updated: "2026-11-09T08:00:00Z",
              body: paragraph("Please add a test."),
            },
          ],
        }),
    ],
  ]);
  const fakeFetch = vi.fn<JiraFetch>(async (input, init) => {
    const url = new URL(input);
    requests.push({ url, init });
    const route = routes.get(url.pathname.replace("/rest/api/3/", ""));
    if (!route) throw new Error(`Unexpected path ${url.pathname}`);
    return route();
  });
  const service = makeJiraService({
    secrets: {
      get: (name) => Effect.sync(() => store.get(name) ?? null),
      set: (name, value) => Effect.sync(() => void store.set(name, value)),
      remove: (name) => Effect.sync(() => void store.delete(name)),
    },
    fetch: fakeFetch,
    timeoutMs: 500,
  });
  const failure = async (effect: Effect.Effect<unknown, JiraError>) =>
    Effect.runPromise(Effect.flip(effect));
  return { service, store, requests, routes, fakeFetch, failure };
}

describe("Jira site and JQL", () => {
  it("accepts only Jira Cloud addresses, in one canonical form", () => {
    expect(normalizeJiraSite(" https://Team.atlassian.net/ ")).toBe(SITE);
    for (const site of [
      "http://team.atlassian.net",
      "https://team.atlassian.net.evil.test",
      "https://evil.test/team.atlassian.net",
      "https://team.atlassian.net/browse/SHP-1",
    ])
      expect(normalizeJiraSite(site)).toBeNull();
  });

  it("builds each list, quotes free text and matches a key exactly", () => {
    expect(buildJiraIssuesJql("assigned")).toBe(
      "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
    );
    expect(buildJiraIssuesJql("recent", "  ")).toBe(
      "issuekey in issueHistory() ORDER BY lastViewed DESC",
    );
    expect(buildJiraIssuesJql("assigned", 'a" OR project = "X\\')).toContain(
      ' AND text ~ "a\\" OR project = \\"X\\\\" ORDER BY ',
    );
    expect(buildJiraIssuesJql("recent", "shp-12")).toBe('issuekey = "SHP-12"');
  });
});

describe("Jira connection", () => {
  it("reports nothing without a connection and contacts no one", async () => {
    const h = harness(null);
    expect(await Effect.runPromise(h.service.status())).toEqual({
      connected: false,
      site: null,
      email: null,
      accountDisplayName: null,
      message: null,
    });
    expect((await h.failure(h.service.issues({ scope: "assigned" }))).code).toBe(
      "JIRA_NOT_CONNECTED",
    );
    expect(h.fakeFetch).not.toHaveBeenCalled();
  });

  it("checks credentials before saving, sends them only to the site, and never returns the token", async () => {
    const h = harness(null);
    const status = await Effect.runPromise(
      h.service.connect({
        site: "https://TEAM.atlassian.net/",
        email: " dana@example.test ",
        token: "secret-token",
      }),
    );
    expect(status).toEqual({
      connected: true,
      site: SITE,
      email: "dana@example.test",
      accountDisplayName: "Dana",
      message: null,
    });
    expect(JSON.stringify(status)).not.toContain("secret-token");
    const sent = h.requests[0];
    expect(sent?.url.origin).toBe(SITE);
    expect(new Headers(sent?.init?.headers).get("Authorization")).toBe(AUTH);
    expect(sent?.init?.redirect).toBe("error");
    expect(h.store.has(JIRA_CONNECTION_SECRET_NAME)).toBe(true);
    expect(await Effect.runPromise(h.service.disconnect())).toMatchObject({ connected: false });
    expect(h.store.size).toBe(0);
  });

  it("saves nothing for a bad address or rejected credentials, keeping a working connection", async () => {
    const h = harness();
    const before = h.store.get(JIRA_CONNECTION_SECRET_NAME);
    expect(
      (await h.failure(h.service.connect({ ...CONNECTION, site: "https://evil.test" }))).code,
    ).toBe("JIRA_INVALID_INPUT");
    expect(h.fakeFetch).not.toHaveBeenCalled();
    h.routes.set("myself", () => json({ message: "secret-token leaked" }, 401));
    const rejected = await h.failure(h.service.connect({ ...CONNECTION, token: "other-token" }));
    expect(rejected.code).toBe("JIRA_AUTH");
    expect(rejected.message).not.toContain("token leaked");
    expect(h.store.get(JIRA_CONNECTION_SECRET_NAME)).toBe(before);
    // A saved connection that stopped working is reported, with why, instead of failing.
    expect(await Effect.runPromise(h.service.status())).toMatchObject({
      connected: false,
      site: SITE,
      message: expect.stringContaining("rejected"),
    });
  });
});

describe("Jira issues", () => {
  it("lists cleaned summaries and skips rows without a valid key", async () => {
    const h = harness();
    const result = await Effect.runPromise(h.service.issues({ scope: "assigned", query: "label" }));
    expect(result.issues).toEqual([
      {
        key: "SHP-4253",
        summary: "FedEx label times out",
        url: `${SITE}/browse/SHP-4253`,
        status: "In Progress",
        statusCategory: "inProgress",
        type: "Bug",
        assignee: "Dana",
        updatedAt: "2026-11-08T12:00:00.000Z",
      },
    ]);
    const body = JSON.parse(String(h.requests[0]?.init?.body)) as { jql: string };
    expect(body.jql).toContain('text ~ "label"');
  });

  it("reads one issue with its description and comments as plain text", async () => {
    const h = harness();
    const issue = await Effect.runPromise(h.service.issue({ key: " shp-4253 " }));
    expect(issue).toMatchObject({
      key: "SHP-4253",
      description: "Large orders time out.",
      comments: [
        { author: "Kai", updatedAt: "2026-11-09T08:00:00.000Z", body: "Please add a test." },
      ],
      commentsTruncated: true,
    });
  });

  it.each([
    [404, "JIRA_NOT_FOUND"],
    [403, "JIRA_FORBIDDEN"],
    [429, "JIRA_RATE_LIMITED"],
    [500, "JIRA_UNAVAILABLE"],
  ] as const)("maps HTTP %i to %s with fixed text", async (status, code) => {
    const h = harness();
    h.routes.set("issue/SHP-4253", () => json({ errorMessages: ["internal detail"] }, status));
    const error = await h.failure(h.service.issue({ key: "SHP-4253" }));
    expect(error).toBeInstanceOf(JiraError);
    expect(error.code).toBe(code);
    expect(error.message).not.toContain("internal detail");
  });

  it("refuses a key that is not one, and treats a network failure as unavailable", async () => {
    const h = harness();
    expect((await h.failure(h.service.issue({ key: "../myself" }))).code).toBe(
      "JIRA_INVALID_INPUT",
    );
    expect(h.fakeFetch).not.toHaveBeenCalled();
    h.fakeFetch.mockRejectedValueOnce(new Error("socket hang up secret-token"));
    const error = await h.failure(h.service.issues({ scope: "recent" }));
    expect(error.code).toBe("JIRA_UNAVAILABLE");
    expect(error.message).not.toContain("secret-token");
  });
});

describe("Jira documents as text", () => {
  it("keeps paragraphs, lists and code, and drops control characters", () => {
    const text = jiraDocumentToText(
      {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Steps‮:" }] },
          {
            type: "bulletList",
            content: [
              { type: "listItem", content: [paragraph("Open the builder").content[0]] },
              { type: "listItem", content: [paragraph("Save").content[0]] },
            ],
          },
          { type: "codeBlock", content: [{ type: "text", text: "npm test" }] },
        ],
      },
      1_000,
    );
    expect(text).toBe("Steps:\n\n- Open the builder\n- Save\n\n```\nnpm test\n```");
    expect(
      jiraDocumentToText({ type: "doc", content: [paragraph("x".repeat(50))] }, 10),
    ).toHaveLength(10);
    expect(jiraDocumentToText(null, 100)).toBe("");
  });
});
