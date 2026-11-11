/**
 * Server-side encoding of the connect shell snapshot.
 *
 * Effect RPC schema-encodes every stream item with the RPC's success schema
 * before `JSON.stringify`. For the shell snapshot that encode walked every
 * thread a second time right after `getShellSnapshot` had decoded (and so
 * validated) the same value, and at a few thousand threads it was about as
 * expensive as the decode. On the shell snapshot's JSON codec that encode is an
 * identity except in two places, so this module reproduces those two and
 * hands the RPC layer a value it passes through unchanged:
 *
 * - `undefined` in an optional key encodes as `null` (`Schema.toCodecJson`).
 * - `ModelSelection` encodes through its persisted source struct, which can
 *   reorder or drop keys; it still goes through its own schema encoder here.
 *
 * Everything else in the shell contract encodes through passthrough getters
 * on plain structs, arrays, unions and literals, so a value that came straight
 * out of `decodeShellSnapshot` already has the encoded value's keys, key order
 * and leaves. `wsShellSnapshotWire.test.ts` fails if the contract gains another
 * non-identity encoding outside the two model-selection paths, and compares
 * the bytes of both paths over decoded snapshots and a seeded database.
 *
 * Precondition: the input must be decode output. The schema encode also puts
 * keys in schema order, drops unknown keys and re-checks refinements; this
 * copy does none of that, so a hand-built or modified snapshot could produce
 * different bytes. `DecodedShellSnapshot` marks the decoded value, and the
 * subscribeShell handler in wsRpc.ts applies it directly to
 * `getShellSnapshot()`, whose result is `decodeShellSnapshot` output.
 *
 * Only the subscribeShell stream on the server uses this; clients decode with
 * the unchanged contract schema, and the bytes on the wire are the same.
 */
import {
  ModelSelection,
  ORCHESTRATION_WS_METHODS,
  OrchestrationRpcSchemas,
  type OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  WsRpcError,
} from "@synara/contracts";
import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

const encodeModelSelectionJson = Schema.encodeUnknownSync(Schema.toCodecJson(ModelSelection));

/** A snapshot already in its JSON-encoded form; the RPC layer passes it through. */
export type ShellSnapshotWire = { readonly __shellSnapshotWire: unique symbol };

declare const decodedShellSnapshot: unique symbol;
/** A shell snapshot exactly as `decodeShellSnapshot` returned it. */
export type DecodedShellSnapshot = OrchestrationShellSnapshot & {
  readonly [decodedShellSnapshot]: true;
};

/**
 * Marks `getShellSnapshot()` output as decode output. Apply it only to a
 * value returned by the snapshot query, never to a built or edited one.
 */
export const asDecodedShellSnapshot = (snapshot: OrchestrationShellSnapshot) =>
  snapshot as DecodedShellSnapshot;

/**
 * Same as the contract's `OrchestrationShellStreamItem`, except that the
 * snapshot member carries a pre-encoded value. Member order matches the
 * contract union, so event items encode exactly as before.
 */
export const ShellStreamWireItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: Schema.Any as Schema.Codec<ShellSnapshotWire>,
  }),
  OrchestrationShellStreamEvent,
]);
export type ShellStreamWireItem = typeof ShellStreamWireItem.Type;

/**
 * Replaces the contract's subscribeShell RPC in the server's handler group.
 * Same tag, payload and error; only the snapshot member's encode differs.
 */
export const WsServerSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: ShellStreamWireItem,
  error: WsRpcError,
  stream: true,
});

// Decoded shell values are plain objects and arrays of JSON leaves; only
// `undefined` differs from its encoded form.
function toJsonValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toJsonValue);
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    out[key] = toJsonValue(record[key]);
  }
  return out;
}

/**
 * Encodes a decoded shell snapshot to the value `Schema.toCodecJson`
 * (`OrchestrationShellSnapshot`) would produce for it. On decode output the
 * schema encode can only fail inside a model selection (an option value the
 * JSON codec rejects); this throws the ModelSelection encoder's error there.
 * Other inputs are outside the contract: see the precondition above.
 */
export function encodeShellSnapshotForWire(snapshot: DecodedShellSnapshot): ShellSnapshotWire {
  const encoded = toJsonValue(snapshot) as {
    threads: Array<{ modelSelection: unknown }>;
    projects: Array<{ defaultModelSelection: unknown }>;
  };
  // Assigning an existing key keeps its position, so key order is unchanged.
  snapshot.threads.forEach((thread, index) => {
    encoded.threads[index]!.modelSelection = encodeModelSelectionJson(thread.modelSelection);
  });
  snapshot.projects.forEach((project, index) => {
    if (project.defaultModelSelection != null) {
      encoded.projects[index]!.defaultModelSelection = encodeModelSelectionJson(
        project.defaultModelSelection,
      );
    }
  });
  return encoded as unknown as ShellSnapshotWire;
}
