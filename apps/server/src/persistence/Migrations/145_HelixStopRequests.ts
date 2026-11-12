import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A Stop the user asked for that Helix could not commit (its pair data
 * unreadable, or storage failing), so the pair stays fenced across a restart
 * until a durable stop commits (docs/plans/helix-prototype.md, section 17). It
 * needs no decoding. Additive; `IF NOT EXISTS` makes a replay a no-op.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS helix_stop_requests (
      pair_id TEXT PRIMARY KEY,
      requested_at TEXT NOT NULL
    )
  `;
});
