import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * User messages whose Helix effects already ran (docs/plans/helix-prototype.md,
 * section 19): the pairing a message carried, and the goal it started. A
 * retried command (the engine replays its receipt, also after a restart) claims
 * nothing twice, so a stale "on" can never undo a later "off". Additive;
 * `IF NOT EXISTS` makes a replay a no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS helix_applied_messages (
      message_id TEXT NOT NULL,
      effect TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      PRIMARY KEY (message_id, effect)
    )
  `;
});
