import { ThreadId, TurnId } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerSettingsService.layerTest()),
  ),
);

const OUTPUT = "src/a.ts:1: export const a = 1;\n".repeat(200);

const codexCommand = (status: string) => ({
  itemType: "command_execution",
  status,
  title: "Ran command",
  detail: "bun run test",
  data: {
    item: {
      type: "commandExecution",
      id: "call_1",
      command: "bun run test",
      status,
      commandActions: [{ type: "unknown", command: "bun run test" }],
      aggregatedOutput: OUTPUT,
      exitCode: 0,
    },
  },
});

const codexFileChange = {
  itemType: "file_change",
  status: "completed",
  title: "File change",
  data: {
    item: {
      type: "fileChange",
      id: "call_2",
      status: "completed",
      changes: [{ path: "/repo/a.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-a\n+b\n" }],
    },
  },
};

const claudeRead = {
  itemType: "dynamic_tool_call",
  title: "Read",
  data: { toolName: "Read", input: { file_path: "/repo/a.ts" }, rawOutput: { content: OUTPUT } },
};

layer("ProjectionSnapshotQuery payload elision", (it) => {
  it.effect("thins settled turns' unread Codex fields in client snapshots only", () =>
    Effect.gen(function* () {
      const query = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.makeUnsafe("elision-thread");
      const now = "2026-11-11T10:00:00.000Z";
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('elision-project', 'Elision', '/tmp/elision-project', '[]', ${now}, ${now})`;
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, latest_turn_id, created_at, updated_at)
        VALUES (${threadId}, 'elision-project', 'Elision', '{"provider":"codex","model":"gpt-5"}',
          'turn-2', ${now}, ${now})`;
      // Only the latest turn needs a row: it decides which activities stay whole.
      yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, state, requested_at, started_at,
         checkpoint_turn_count, checkpoint_status, checkpoint_files_json)
        VALUES (${threadId}, 'turn-2', 'running', ${now}, ${now}, 0, 'missing', '[]')`;
      const rows = [
        ["old-command", "turn-1", "tool.completed", codexCommand("completed")],
        ["old-patch", "turn-1", "tool.completed", codexFileChange],
        ["old-claude", "turn-1", "tool.completed", claudeRead],
        ["latest-command", "turn-2", "tool.completed", codexCommand("completed")],
        ["turnless-command", null, "tool.completed", codexCommand("completed")],
      ] as const;
      for (const [index, [id, turnId, kind, payload]] of rows.entries()) {
        yield* sql`INSERT INTO projection_thread_activities
          (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
          VALUES (${id}, ${threadId}, ${turnId}, 'tool', ${kind}, 'Work', ${JSON.stringify(payload)},
            ${index + 1}, ${now})`;
      }

      const snapshot = Option.getOrThrow(yield* query.getThreadDetailSnapshotById(threadId));
      const byId = new Map(snapshot.thread.activities.map((activity) => [activity.id, activity]));
      assert.equal(snapshot.thread.latestTurn?.turnId, TurnId.makeUnsafe("turn-2"));

      const { aggregatedOutput: _output, ...commandItem } = codexCommand("completed").data.item;
      assert.deepStrictEqual(byId.get("old-command" as never)?.payload, {
        ...codexCommand("completed"),
        data: { item: commandItem },
      });
      assert.deepStrictEqual(byId.get("old-patch" as never)?.payload, {
        ...codexFileChange,
        data: {
          item: {
            ...codexFileChange.data.item,
            changes: [{ path: "/repo/a.ts", kind: { type: "update" } }],
          },
        },
      });
      // Fields clients read, the live (latest) turn, and turnless rows stay whole.
      assert.deepStrictEqual(byId.get("old-claude" as never)?.payload, claudeRead);
      assert.deepStrictEqual(
        byId.get("latest-command" as never)?.payload,
        codexCommand("completed"),
      );
      assert.deepStrictEqual(
        byId.get("turnless-command" as never)?.payload,
        codexCommand("completed"),
      );

      // Server-side readers and the stored row keep the full payload.
      const detail = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
      assert.deepStrictEqual(
        detail.activities.find((activity) => activity.id === "old-command")?.payload,
        codexCommand("completed"),
      );
      const [stored] = yield* sql<{ payload: string }>`
        SELECT payload_json AS payload FROM projection_thread_activities
        WHERE activity_id = 'old-command'`;
      assert.deepStrictEqual(JSON.parse(stored!.payload), codexCommand("completed"));
    }),
  );
});
