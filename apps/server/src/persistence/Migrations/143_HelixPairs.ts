import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Helix Lead/Builder pairs (docs/plans/helix-prototype.md).
 *
 * A state-table aggregate like Hubs, not event-sourced: one row per pair and
 * one row per handoff. Typed columns carry everything the server queries or
 * constrains; the `*_json` columns carry contract-shaped payloads decoded with
 * the `@synara/contracts` Helix schemas. Idempotent: every statement is
 * `IF NOT EXISTS`, so a replay over an existing schema is a no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS helix_pairs (
      pair_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      lead_thread_id TEXT NOT NULL UNIQUE,
      builder_thread_id TEXT NOT NULL UNIQUE,
      builder_created_at TEXT,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'disabled')),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      cancellation_epoch INTEGER NOT NULL CHECK (cancellation_epoch >= 0),
      hold_json TEXT,
      goal_json TEXT NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (lead_thread_id <> builder_thread_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS helix_handoffs (
      handoff_id TEXT PRIMARY KEY,
      pair_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 1),
      request_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      work_item_id TEXT NOT NULL,
      previous_handoff_id TEXT,
      correction_index INTEGER NOT NULL CHECK (correction_index >= 0),
      goal_seq INTEGER NOT NULL CHECK (goal_seq >= 0),
      epoch INTEGER NOT NULL CHECK (epoch >= 0),
      state TEXT NOT NULL CHECK (state IN (
        'prepared', 'dispatching', 'running', 'awaiting_review', 'accepted',
        'changes_requested', 'blocked', 'failed', 'interrupted', 'cancelled', 'uncertain'
      )),
      delivery TEXT NOT NULL CHECK (delivery IN (
        'none', 'pending', 'returned_in_tool', 'wake_requested', 'wake_dispatched',
        'acknowledged', 'suppressed'
      )),
      revision INTEGER NOT NULL CHECK (revision >= 0),
      dispatch_command_id TEXT,
      wake_command_id TEXT,
      builder_turn_id TEXT,
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (pair_id, request_id),
      UNIQUE (pair_id, sequence)
    )
  `;

  // One Builder slot per pair: at most one handoff may be prepared, dispatching or running.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_helix_handoffs_one_active
    ON helix_handoffs (pair_id)
    WHERE state IN ('prepared', 'dispatching', 'running')
  `;

  // The provider command reactor resolves a server-originated turn back to its handoff.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_helix_handoffs_dispatch_command
    ON helix_handoffs (dispatch_command_id)
    WHERE dispatch_command_id IS NOT NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_helix_handoffs_wake_command
    ON helix_handoffs (wake_command_id)
    WHERE wake_command_id IS NOT NULL
  `;

  // Startup reconciliation scans only unresolved work.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_helix_handoffs_unresolved
    ON helix_handoffs (pair_id, state)
    WHERE state IN ('prepared', 'dispatching', 'running', 'awaiting_review')
      OR delivery IN ('pending', 'wake_requested')
  `;
});
