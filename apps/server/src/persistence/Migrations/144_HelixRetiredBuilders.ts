import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Threads that were Helix Builders and must never run again
 * (docs/plans/helix-prototype.md, section 17).
 *
 * A Builder's gateway restriction is derived from its pair row. When the pair
 * is removed, or a disabled pair's Builder is deleted, that row is gone while a
 * provider session (and the credential it holds) may still be stopping. A row
 * here keeps the thread retired for good, across restarts: no capabilities, no
 * turns, never an ordinary chat. Additive; `IF NOT EXISTS` makes a replay a no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS helix_retired_threads (
      thread_id TEXT PRIMARY KEY,
      pair_id TEXT NOT NULL,
      retired_at TEXT NOT NULL
    )
  `;
});
