// Guard for the server's thread-detail payload elision (`elideUnreadActivityPayloadFields`
// in packages/contracts): settled-turn activities reach the client without Codex
// `data.item.aggregatedOutput` and `data.item.changes[i].diff`.
//
// What this file checks:
// - Behaviour: with and without elision, these pure client consumers of
//   `thread.activities` return the same result for the fixtures below (Codex command,
//   failed command, read, search, file change, and the elidable fields placed on MCP
//   and collab items too), with no latest/active turn, with the fixture turn live, and
//   with it settled: work-log derivation (collapsed and expanded rows, `toolDetails`),
//   the tool-call details extractor the dialog renders, the readable tool title and
//   MCP server helpers, sub-agent presentation from parent activities, the store's
//   duplicate resolution (detail score), task-completion and attention notification
//   candidates, and the session-logic background/subagent/task/pending derivations.
// - Source: no non-test client source (apps/web/src, apps/desktop/src, packages/*)
//   names `aggregatedOutput`, or reads `.diff` / `["diff"]` on the same line as a
//   `change`/`changes` identifier.
//
// What it cannot check:
// - Payload shapes the fixtures do not model, and consumers not called here (React
//   components that read a payload directly, or a reader added in a new module).
// - A reader the source guard cannot see: a destructured `{ diff }` from a change
//   object, a computed key, or a generic walk over every key of `data.item`.
//
// Rule for a future reader of an elided field: the client store can hold the elided
// copy of a settled-turn activity even when the full payload arrived live, because a
// later snapshot replaces it (`normalizeActivities` keeps the incoming copy when the
// detail scores tie; the last behaviour test pins that). So remove the field from the
// elision first, then add the reader.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  elideUnreadActivityPayloadFields,
  type OrchestrationThreadActivity,
  TurnId,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { resolveSubagentPresentationForThread } from "./lib/subagentPresentation";
import { deriveReadableToolTitle, extractMcpServerName } from "./lib/toolCallLabel";
import { deriveWorkLogToolDetails } from "./lib/toolCallDetails";
import {
  collectCompletedThreadCandidates,
  collectThreadAttentionCandidates,
} from "./notifications/taskCompletion.logic";
import { derivePendingApprovals, derivePendingUserInputs } from "./pendingInteractionDerivation";
import {
  countOutstandingBackgroundWork,
  deriveActiveBackgroundTasksState,
  deriveActiveTaskListState,
  deriveOutstandingBackgroundTaskIds,
  derivePendingBackgroundWork,
  deriveRunningSubagentTasks,
} from "./session-logic";
import { dedupeActivitiesById, normalizeActivities } from "./storeNormalization";
import { makeActivity, makeThread } from "./storeTestFixtures";
import type { Thread } from "./types";
import { deriveWorkLogEntries } from "./workLog";

const TURN = "turn-1";
const OTHER_TURN = "turn-2";

const LONG_OUTPUT = Array.from(
  { length: 400 },
  (_, index) => `src/file${index}.ts:${index + 1}: export const value${index} = ${index};`,
).join("\n");

const PATCH = [
  "@@ -1,3 +1,4 @@",
  " import { a } from './a';",
  "-const b = 1;",
  "+const b = 2;",
  "+const c = 3;",
].join("\n");

const CHANGES = [
  { path: "/repo/src/a.ts", kind: { type: "update", move_path: null }, diff: PATCH },
  { path: "/repo/src/b.ts", kind: { type: "add" }, diff: "+export const b = 1;\n" },
];

function activity(input: {
  id: string;
  kind: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}): OrchestrationThreadActivity {
  return makeActivity({ ...input, turnId: TURN, payload: input.payload as never });
}

function codexCommand(input: {
  id: string;
  kind: "tool.started" | "tool.completed";
  status: string;
  command: string;
  aggregatedOutput: string | null;
  exitCode: number | null;
  createdAt: string;
  commandActions?: unknown[];
}): OrchestrationThreadActivity {
  return activity({
    id: input.id,
    kind: input.kind,
    summary: input.kind === "tool.started" ? "Ran command started" : "Ran command",
    createdAt: input.createdAt,
    payload: {
      itemType: "command_execution",
      status: input.status,
      title: "Ran command",
      detail: input.command,
      data: {
        item: {
          type: "commandExecution",
          id: `call_${input.id}`,
          command: input.command,
          cwd: "/repo",
          processId: "38005",
          source: "unifiedExecStartup",
          status: input.status,
          commandActions: input.commandActions ?? [{ type: "unknown", command: input.command }],
          aggregatedOutput: input.aggregatedOutput,
          exitCode: input.exitCode,
          durationMs: input.exitCode === null ? null : 42,
        },
        threadId: "provider-thread",
        turnId: "provider-turn",
      },
    },
  });
}

const FIXTURES: OrchestrationThreadActivity[] = [
  codexCommand({
    id: "cmd-start",
    kind: "tool.started",
    status: "inProgress",
    command: "/bin/zsh -lc 'bun run test src/a.test.ts'",
    aggregatedOutput: null,
    exitCode: null,
    createdAt: "2026-11-11T10:00:01.000Z",
  }),
  codexCommand({
    id: "cmd-done",
    kind: "tool.completed",
    status: "completed",
    command: "/bin/zsh -lc 'bun run test src/a.test.ts'",
    aggregatedOutput: LONG_OUTPUT,
    exitCode: 0,
    createdAt: "2026-11-11T10:00:02.000Z",
  }),
  codexCommand({
    id: "cmd-failed",
    kind: "tool.completed",
    status: "failed",
    command: "bun run test --runInBand",
    aggregatedOutput: "Unknown option --runInBand\n<exited with exit code 1>",
    exitCode: 1,
    createdAt: "2026-11-11T10:00:03.000Z",
  }),
  codexCommand({
    id: "cmd-read",
    kind: "tool.completed",
    status: "completed",
    command: "/bin/zsh -lc \"sed -n '1,80p' src/a.ts\"",
    aggregatedOutput: LONG_OUTPUT,
    exitCode: 0,
    createdAt: "2026-11-11T10:00:04.000Z",
    commandActions: [
      { type: "read", command: "sed -n '1,80p' src/a.ts", name: "a.ts", path: "src/a.ts" },
    ],
  }),
  codexCommand({
    id: "cmd-search",
    kind: "tool.completed",
    status: "completed",
    command: '/bin/zsh -lc "rg -n deriveRows src"',
    aggregatedOutput: LONG_OUTPUT,
    exitCode: 0,
    createdAt: "2026-11-11T10:00:05.000Z",
    commandActions: [
      { type: "search", command: "rg -n deriveRows src", query: "deriveRows", path: "src" },
    ],
  }),
  ...(["tool.started", "tool.completed"] as const).map((kind, index) =>
    activity({
      id: `patch-${index}`,
      kind,
      summary: "File change",
      createdAt: `2026-11-11T10:00:0${6 + index}.000Z`,
      payload: {
        itemType: "file_change",
        status: kind === "tool.started" ? "inProgress" : "completed",
        title: "File change",
        data: {
          item: {
            type: "fileChange",
            id: "call_patch",
            status: kind === "tool.started" ? "inProgress" : "completed",
            changes: CHANGES,
          },
        },
      },
    }),
  ),
  // The elidable fields on other item types, so readers gated on those types run too.
  activity({
    id: "mcp-done",
    kind: "tool.completed",
    summary: "MCP tool call",
    createdAt: "2026-11-11T10:00:08.000Z",
    payload: {
      itemType: "mcp_tool_call",
      status: "completed",
      title: "MCP tool call",
      data: {
        item: {
          type: "mcpToolCall",
          id: "call_mcp",
          server: "linear",
          tool: "get_issue",
          arguments: { id: "ENG-1" },
          status: "completed",
          result: { content: [{ type: "text", text: "Issue ENG-1" }] },
          aggregatedOutput: LONG_OUTPUT,
          changes: CHANGES,
        },
      },
    },
  }),
  activity({
    id: "collab-spawn",
    kind: "tool.completed",
    summary: "Spawned agent",
    createdAt: "2026-11-11T10:00:09.000Z",
    payload: {
      itemType: "collab_agent_tool_call",
      status: "completed",
      title: "Spawn agent",
      data: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "provider-thread",
          receiverThreadIds: ["child-provider-thread"],
          prompt: "Investigate the flaky timeline test",
          agentsStates: { "child-provider-thread": { status: "completed", message: "Done" } },
          aggregatedOutput: LONG_OUTPUT,
          changes: CHANGES,
        },
      },
    },
  }),
  // Not tool rows: they make the approval, notification and task derivations below
  // produce output, and carry the elidable fields so a reader there would show.
  makeActivity({
    id: "approval",
    kind: "approval.requested",
    summary: "Command approval requested",
    tone: "approval",
    turnId: TURN,
    createdAt: "2026-11-11T10:00:10.000Z",
    payload: {
      requestId: "approval-1",
      requestKind: "command",
      detail: "bun run test",
      data: { item: { type: "commandExecution", aggregatedOutput: LONG_OUTPUT, changes: CHANGES } },
    },
  }),
  makeActivity({
    id: "task-start",
    kind: "task.started",
    summary: "Task started",
    tone: "info",
    turnId: TURN,
    createdAt: "2026-11-11T10:00:11.000Z",
    payload: {
      taskId: "task-1",
      taskType: "subagent",
      toolUseId: "call_collab",
      data: { item: { aggregatedOutput: LONG_OUTPUT, changes: CHANGES } },
    },
  }),
  makeActivity({
    id: "task-background",
    kind: "task.updated",
    summary: "Task updated",
    tone: "info",
    turnId: TURN,
    createdAt: "2026-11-11T10:00:12.000Z",
    payload: { taskId: "task-1", isBackgrounded: true, status: "running" },
  }),
];

function elide(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  return activities.map((entry) => ({
    ...entry,
    payload: elideUnreadActivityPayloadFields(entry.payload),
  }));
}

// Entries carry presentation callbacks; compare everything that is data.
function data(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null));
}

const TURN_SCENARIOS = [
  { name: "no latest or active turn", latestTurnId: undefined, options: {} },
  {
    name: "fixture turn live",
    latestTurnId: TurnId.makeUnsafe(TURN),
    options: {
      visibleTurnIds: new Set([TURN]),
      activeTurnId: TurnId.makeUnsafe(TURN),
      activeTurnStartedAt: "2026-11-11T10:00:00.000Z",
      latestTurnState: "running" as const,
    },
  },
  {
    name: "fixture turn settled",
    latestTurnId: TurnId.makeUnsafe(OTHER_TURN),
    // The timeline passes every rendered turn; without it only the latest turn's
    // activities are kept and the settled fixture turn would derive nothing.
    options: {
      visibleTurnIds: new Set([TURN, OTHER_TURN]),
      activeTurnId: null,
      latestTurnState: "completed" as const,
      latestTurnCompletedAt: "2026-11-11T10:05:00.000Z",
    },
  },
];

function threadWith(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  state: "running" | "completed",
): Thread {
  return makeThread({
    activities: [...activities],
    hasPendingApprovals: state === "running",
    session: {
      provider: "codex",
      status: state === "running" ? "running" : "ready",
      orchestrationStatus: state === "running" ? "running" : "ready",
      createdAt: "2026-11-11T10:00:00.000Z",
      updatedAt: "2026-11-11T10:00:00.000Z",
    },
    latestTurn: {
      turnId: TurnId.makeUnsafe(TURN),
      state,
      requestedAt: "2026-11-11T10:00:00.000Z",
      startedAt: "2026-11-11T10:00:00.000Z",
      completedAt: state === "completed" ? "2026-11-11T10:05:00.000Z" : null,
      assistantMessageId: null,
    },
  } as Partial<Thread>);
}

describe("elideUnreadActivityPayloadFields", () => {
  it("drops Codex command output and per-change patches", () => {
    const serialized = JSON.stringify(elide(FIXTURES).map((entry) => entry.payload));
    // A started command's `aggregatedOutput: null` stays; only captured output goes.
    expect(serialized).not.toContain('"aggregatedOutput":"');
    expect(serialized).not.toContain('"diff"');
    expect(serialized.length).toBeLessThan(
      JSON.stringify(FIXTURES.map((entry) => entry.payload)).length / 4,
    );
  });

  it("keeps payloads without elidable fields by reference and never mutates", () => {
    const claudeRead = makeActivity({
      id: "claude-read",
      kind: "tool.completed",
      payload: {
        itemType: "dynamic_tool_call",
        title: "Read",
        data: {
          toolName: "Read",
          input: { file_path: "/repo/src/a.ts" },
          rawOutput: { content: LONG_OUTPUT },
        },
      },
    });
    expect(elideUnreadActivityPayloadFields(claudeRead.payload)).toBe(claudeRead.payload);
    expect(elideUnreadActivityPayloadFields(FIXTURES[0]!.payload)).toBe(FIXTURES[0]!.payload);
    expect(elideUnreadActivityPayloadFields(null)).toBeNull();
    expect(elideUnreadActivityPayloadFields("text")).toBe("text");
    const before = JSON.stringify(FIXTURES);
    elide(FIXTURES);
    expect(JSON.stringify(FIXTURES)).toBe(before);
  });

  for (const scenario of TURN_SCENARIOS) {
    it(`leaves work-log entries unchanged (${scenario.name})`, () => {
      const derive = (activities: ReadonlyArray<OrchestrationThreadActivity>) =>
        data(deriveWorkLogEntries(activities, scenario.latestTurnId, scenario.options));
      const full = derive(FIXTURES);
      // The fixture rows were derived at all, so the comparison is not vacuous.
      expect((full as unknown[]).length).toBeGreaterThan(4);
      expect(derive(elide(FIXTURES))).toEqual(full);
      // One activity at a time too: collapse/merge can hide a per-row difference.
      for (const entry of FIXTURES) {
        expect(derive(elide([entry]))).toEqual(derive([entry]));
      }
    });
  }

  it("leaves the dialog's tool-call details and title helpers unchanged", () => {
    const elided = elide(FIXTURES);
    FIXTURES.forEach((entry, index) => {
      const full = entry.payload as Record<string, unknown>;
      const thin = elided[index]!.payload as Record<string, unknown>;
      for (const requestKind of ["command", "file-change", "tool"] as const) {
        const details = (payload: Record<string, unknown>) =>
          data(
            deriveWorkLogToolDetails({
              payload,
              itemType: payload.itemType as never,
              requestKind,
              label: entry.summary,
            }),
          );
        expect(details(thin)).toEqual(details(full));
      }
      for (const isRunning of [true, false]) {
        const title = (payload: Record<string, unknown>) =>
          deriveReadableToolTitle({
            title: "Ran command",
            fallbackLabel: entry.summary,
            itemType: payload.itemType as never,
            payload,
            isRunning,
          });
        expect(title(thin)).toEqual(title(full));
      }
      expect(extractMcpServerName(null, thin)).toBe(extractMcpServerName(null, full));
    });
  });

  it("leaves sub-agent presentation from parent activities unchanged", () => {
    const present = (activities: ReadonlyArray<OrchestrationThreadActivity>) => {
      const child = {
        id: "subagent:parent:child-provider-thread",
        title: null,
        parentThreadId: "parent",
        subagentAgentId: null,
      };
      return data(
        resolveSubagentPresentationForThread({
          thread: child,
          threads: [{ id: "parent", activities: [...activities] }, child],
        }),
      );
    };
    expect(present(elide(FIXTURES))).toEqual(present(FIXTURES));
  });

  it("gives the store's duplicate resolution the same detail score", () => {
    // `preferRicherActivity` keeps the incoming copy unless it scores lower, so the
    // incoming copy winning in both orders means the two scores are equal.
    const elided = elide(FIXTURES);
    FIXTURES.forEach((full, index) => {
      const thin = elided[index]!;
      expect(dedupeActivitiesById([full, thin])[0]?.payload).toEqual(thin.payload);
      expect(dedupeActivitiesById([thin, full])[0]?.payload).toEqual(full.payload);
    });
  });

  it("leaves notification candidates and session derivations unchanged", () => {
    const derive = (activities: ReadonlyArray<OrchestrationThreadActivity>) => {
      const running = threadWith(activities, "running");
      const completed = threadWith(activities, "completed");
      const before = threadWith([], "running");
      return data({
        completed: collectCompletedThreadCandidates([running], [completed]),
        completedWaiting: collectCompletedThreadCandidates([running], [completed], {
          waitForSubagents: true,
        }),
        attention: collectThreadAttentionCandidates([before], [running]),
        outstanding: deriveOutstandingBackgroundTaskIds(activities),
        outstandingCount: countOutstandingBackgroundWork({
          activities,
          session: running.session,
        }),
        subagents: deriveRunningSubagentTasks({
          activities,
          liveTurnId: TurnId.makeUnsafe(TURN),
          sessionStatus: "running",
        }),
        taskList: deriveActiveTaskListState(activities, TurnId.makeUnsafe(TURN)),
        backgroundTasks: deriveActiveBackgroundTasksState(activities, TurnId.makeUnsafe(TURN)),
        pendingBackground: derivePendingBackgroundWork({
          activities,
          latestTurn: running.latestTurn,
          session: running.session,
        }),
        approvals: derivePendingApprovals(activities),
        userInputs: derivePendingUserInputs(activities),
      });
    };
    const full = derive(FIXTURES) as Record<string, unknown[] | number | null>;
    // Not vacuous: the approval, the background task and the subagent task all derive.
    expect(full.attention).toHaveLength(1);
    expect(full.approvals).toHaveLength(1);
    expect(full.outstanding).toEqual(["task-1"]);
    expect(derive(elide(FIXTURES))).toEqual(full);
  });

  it("is what the store keeps after a resnapshot, even over a live full payload", () => {
    // Pins the rule in the header: a later snapshot's elided copy replaces the full
    // payload that arrived live, so no reader may depend on an elided field.
    const live = FIXTURES.filter((entry) => entry.id === "cmd-done");
    const resnapshot = elide(live);
    const merged = normalizeActivities(resnapshot as never, live as never);
    expect(merged[0]?.payload).toEqual(resnapshot[0]!.payload);
    expect(merged[0]?.payload).not.toEqual(live[0]!.payload);
  });
});

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLIENT_SOURCE_ROOTS = ["apps/web/src", "apps/desktop/src", "packages"];
const ELISION_HELPER = "packages/contracts/src/activityPayloadElision.ts";
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u;
const TEST_FILE = /\.(?:test|browser|spec)\.[^/]+$|\.test-support\.[^/]+$/u;
const SKIPPED_DIRS = new Set(["node_modules", "dist", "dist-electron", "build", ".turbo"]);

function clientSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(path);
        continue;
      }
      if (
        SOURCE_FILE.test(entry.name) &&
        !TEST_FILE.test(entry.name) &&
        relative(REPO_ROOT, path) !== ELISION_HELPER
      ) {
        files.push(path);
      }
    }
  };
  for (const root of CLIENT_SOURCE_ROOTS) walk(join(REPO_ROOT, root));
  return files;
}

describe("client sources do not read elided activity fields", () => {
  const files = clientSourceFiles();

  it("scans the client source tree", () => {
    expect(files.some((path) => path.endsWith("apps/web/src/workLog.ts"))).toBe(true);
    expect(files.some((path) => path.includes("apps/desktop/src/"))).toBe(true);
    expect(files.some((path) => path.includes("packages/shared/src/"))).toBe(true);
  });

  it("never names aggregatedOutput", () => {
    const offenders = files.filter((path) =>
      readFileSync(path, "utf8").includes("aggregatedOutput"),
    );
    expect(offenders.map((path) => relative(REPO_ROOT, path))).toEqual([]);
  });

  it("never reads .diff on a change", () => {
    const pattern =
      /[Cc]hanges?\b[^;\n]*\.diff\b|\.diff\b[^;\n]*[Cc]hanges?\b|\[\s*["'`]diff["'`]\s*\]/u;
    const offenders = files.flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          pattern.test(line) ? [`${relative(REPO_ROOT, path)}:${index + 1}`] : [],
        ),
    );
    expect(offenders).toEqual([]);
  });
});
