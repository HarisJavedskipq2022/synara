import {
  ModelSelection,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  OrchestrationLatestTurn,
  OrchestrationSession,
  OrchestrationThreadShell,
  PersistedProviderKind,
  ProviderKind,
  WsOrchestrationSubscribeShellRpc,
} from "@synara/contracts";
import { Schema, SchemaAST, SchemaGetter } from "effect";
import { FastCheck } from "effect/testing";
import { RpcSchema } from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";

import {
  asDecodedShellSnapshot,
  encodeShellSnapshotForWire,
  WsServerSubscribeShellRpc,
} from "./wsShellSnapshotWire.ts";

/**
 * The bytes Effect RPC writes for one stream chunk, built the way
 * `RpcServer.getSchemas` builds `encodeChunk` (the RPC's stream success schema
 * through `Schema.toCodecJson`), then `RpcSerialization.json`.
 * `wsShellSnapshotWire.rpc.test.ts` covers the real server end to end.
 */
function chunkBytes(rpc: { readonly successSchema: Schema.Top }, values: ReadonlyArray<unknown>) {
  if (!RpcSchema.isStreamSchema(rpc.successSchema)) throw new Error("expected a stream RPC");
  const success = (rpc.successSchema as unknown as { readonly success: Schema.Top }).success;
  const encodeChunk = Schema.encodeUnknownSync(
    Schema.toCodecJson(Schema.Array(success as Schema.Codec<unknown, unknown>)),
  );
  return JSON.stringify({ _tag: "Chunk", requestId: "1", values: encodeChunk(values) });
}

type Outcome = { readonly ok: true; readonly bytes: string } | { readonly ok: false };
const attempt = (run: () => string): Outcome => {
  try {
    return { ok: true, bytes: run() };
  } catch {
    return { ok: false };
  }
};

const decodeShellSnapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot);
// The non-JSON encoded side: the shape getShellSnapshot hands to decode.
const encodeShellSnapshotRaw = Schema.encodeUnknownSync(OrchestrationShellSnapshot);

/** Contract path vs server path for one decode output. */
function compareDecoded(raw: unknown): "match" | "both-throw" | "not-decodable" {
  let decoded: OrchestrationShellSnapshot;
  try {
    decoded = decodeShellSnapshot(raw);
  } catch {
    return "not-decodable";
  }
  const contract = attempt(() =>
    chunkBytes(WsOrchestrationSubscribeShellRpc, [{ kind: "snapshot", snapshot: decoded }]),
  );
  const server = attempt(() =>
    chunkBytes(WsServerSubscribeShellRpc, [
      { kind: "snapshot", snapshot: encodeShellSnapshotForWire(asDecodedShellSnapshot(decoded)) },
    ]),
  );
  expect(server.ok, "both paths must fail on the same snapshots").toBe(contract.ok);
  if (contract.ok && server.ok) {
    expect(server.bytes).toBe(contract.bytes);
    return "match";
  }
  return "both-throw";
}

// Deterministic perturbations of a raw snapshot before decode: shuffled keys,
// excess keys, and (unless `reorderOnly`) present-undefined values and dropped
// keys, which often make the snapshot undecodable.
function makePerturb(seed: number, reorderOnly = false) {
  let state = seed;
  const random = () => (state = (state * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff;
  const perturb = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(perturb);
    if (value === null || typeof value !== "object") return value;
    const entries = Object.entries(value).map(([key, inner]) => [key, perturb(inner)] as const);
    const shuffled = [...entries];
    for (let index = shuffled.length - 1; index > 0; index--) {
      const swap = Math.floor(random() * (index + 1));
      [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
    }
    const out: Record<string, unknown> = {};
    for (const [key, inner] of shuffled) {
      const roll = reorderOnly ? 1 : random();
      if (roll < 0.08) continue;
      out[key] = roll < 0.16 ? undefined : inner;
    }
    if (random() < 0.3) out.__excess = { nested: 1 };
    return out;
  };
  return perturb;
}

const OPTIONAL_THREAD_KEYS = Object.entries(OrchestrationThreadShell.fields)
  .filter(([, field]) => SchemaAST.isOptional((field as Schema.Top).ast))
  .map(([key]) => key);

const MODEL_SELECTIONS_RAW = [
  { provider: "codex", model: "gpt-5-codex" },
  { provider: "claudeAgent", instanceId: "work", model: "opus", options: { effort: "high" } },
  { model: "legacy" },
];

/**
 * Lists every place in a snapshot schema's JSON codec whose encode is not an
 * identity the wire encoder reproduces (passthrough getters, or the
 * `undefined` to `null` link `toCodecJson` adds), outside the two paths the
 * encoder re-encodes with the ModelSelection codec.
 */
function nonIdentityEncodings(schema: Schema.Top): string[] {
  const passthrough = SchemaGetter.passthrough();
  // The encoder re-encodes exactly these two paths with the ModelSelection codec.
  const reencodedPaths = new Set([
    "snapshot.threads[].modelSelection",
    "snapshot.projects[].defaultModelSelection",
  ]);
  const found = new Set<string>();
  // Keyed by node and by whether it sits under a re-encoded path: a node first
  // reached inside one must still be walked where it is used normally.
  const seen = { exempt: new Set<SchemaAST.AST>(), checked: new Set<SchemaAST.AST>() };
  const walk = (ast: SchemaAST.AST, path: string, exempt: boolean): void => {
    for (const link of ast.encoding ?? []) {
      const transformation = link.transformation;
      const identity =
        transformation._tag === "Transformation" && transformation.encode === passthrough;
      // `toCodecJson` encodes `undefined` as `null`, which the wire encoder mirrors.
      const undefinedToNull = ast._tag === "Undefined" && link.to._tag === "Null";
      if (!identity && !undefinedToNull && !exempt) {
        found.add(`${path} (${ast._tag} -> ${link.to._tag})`);
      }
      walk(link.to, `${path}>encoded`, exempt);
    }
    const visited = exempt ? seen.exempt : seen.checked;
    if (visited.has(ast)) return;
    visited.add(ast);
    switch (ast._tag) {
      case "Objects":
        for (const property of ast.propertySignatures) {
          const childPath = `${path}.${String(property.name)}`;
          walk(property.type, childPath, exempt || reencodedPaths.has(childPath));
        }
        if (ast.indexSignatures.length > 0 && !exempt) found.add(`${path} (index signature)`);
        break;
      case "Arrays":
        for (const element of [...ast.elements, ...ast.rest]) walk(element, `${path}[]`, exempt);
        break;
      case "Union":
        for (const member of ast.types) walk(member, path, exempt);
        break;
      case "Suspend":
        walk(ast.thunk(), path, exempt);
        break;
      case "Declaration":
      case "Unknown":
      case "Any":
      case "ObjectKeyword":
      case "BigInt":
      case "Symbol":
      case "UniqueSymbol":
        if (!exempt) found.add(`${path} (${ast._tag})`);
        break;
    }
  };
  walk(Schema.toCodecJson(schema as Schema.Codec<unknown, unknown>).ast, "snapshot", false);
  return [...found].toSorted();
}

describe("shell snapshot wire encoding", () => {
  it("has no non-identity JSON encoding outside the two model-selection paths", () => {
    expect(nonIdentityEncodings(OrchestrationShellSnapshot)).toEqual([
      // PersistedProviderKind encodes with `(provider) => provider as string`.
      "snapshot.threads[].handoff.sourceProvider (Union -> String)",
    ]);
    const encodeProvider = Schema.encodeUnknownSync(Schema.toCodecJson(PersistedProviderKind));
    expect(ProviderKind.literals.length).toBeGreaterThan(0);
    for (const provider of ProviderKind.literals) {
      expect(encodeProvider(provider)).toBe(provider);
    }
  });

  it("audit flags encodings the wire encoder would not reproduce", () => {
    const threadFields = OrchestrationThreadShell.fields;
    const withThreadFields = (fields: Record<string, Schema.Top>) =>
      Schema.Struct({
        ...OrchestrationShellSnapshot.fields,
        threads: Schema.Array(Schema.Struct({ ...threadFields, ...fields })),
      });
    // A field named like an exempt one, at a path the encoder does not re-encode.
    const session = Schema.NullOr(
      Schema.Struct({
        ...OrchestrationSession.fields,
        modelSelection: Schema.optional(Schema.NumberFromString),
      }),
    );
    expect(
      nonIdentityEncodings(withThreadFields({ session })).some((entry) =>
        entry.startsWith("snapshot.threads[].session.modelSelection"),
      ),
    ).toBe(true);
    const latestTurn = Schema.NullOr(
      Schema.Struct({ ...OrchestrationLatestTurn.fields, modelSelection: ModelSelection }),
    );
    expect(
      nonIdentityEncodings(withThreadFields({ latestTurn })).some((entry) =>
        entry.startsWith("snapshot.threads[].latestTurn.modelSelection"),
      ),
    ).toBe(true);
    // A composite first reached under an exempt path and reused elsewhere.
    const shared = Schema.Struct({ value: Schema.NumberFromString });
    expect(
      nonIdentityEncodings(
        withThreadFields({
          modelSelection: Schema.Struct({ provider: Schema.String, shared }),
          extra: shared,
        }),
      ).some((entry) => entry.startsWith("snapshot.threads[].extra.value")),
    ).toBe(true);
  });

  it("writes the contract bytes for decode output of generated, perturbed raw snapshots", () => {
    const samples = FastCheck.sample(Schema.toArbitrary(OrchestrationShellSnapshot), {
      numRuns: 1_000,
      seed: 7,
    });
    const perturb = makePerturb(12_345);
    const reorder = makePerturb(54_321, true);
    const counts = { match: 0, "both-throw": 0, "not-decodable": 0 };
    for (const sample of samples) {
      let raw: unknown;
      try {
        raw = encodeShellSnapshotRaw(sample);
      } catch {
        continue;
      }
      counts[compareDecoded(raw)]++;
      counts[compareDecoded(reorder(raw))]++;
      counts[compareDecoded(perturb(raw))]++;
      counts[compareDecoded(perturb(raw))]++;
    }
    // Raw encode rejects many arbitrary model selections, and perturbation
    // drops required keys; the next test pins model selections for coverage.
    expect(counts.match + counts["both-throw"]).toBeGreaterThan(400);
  });

  it("writes the contract bytes for decode output with encodable model selections", () => {
    const decodeModelSelection = Schema.decodeUnknownSync(ModelSelection);
    const selections = MODEL_SELECTIONS_RAW.map((raw) => decodeModelSelection(raw));
    const samples = FastCheck.sample(Schema.toArbitrary(OrchestrationShellSnapshot), {
      numRuns: 400,
      seed: 41,
    });
    const perturb = makePerturb(99);
    const reorder = makePerturb(98, true);
    const counts = { match: 0, "both-throw": 0, "not-decodable": 0 };
    let threads = 0;
    for (const sample of samples) {
      // Assigning existing keys keeps their position in the cloned objects.
      const typed = structuredClone(sample) as unknown as {
        projects: Array<Record<string, unknown>>;
        threads: Array<Record<string, unknown>>;
      };
      typed.projects.forEach((project, index) => {
        project.defaultModelSelection = index % 2 === 0 ? null : selections[index % 3];
      });
      typed.threads.forEach((thread, index) => {
        thread.modelSelection = selections[index % 3];
      });
      let raw: unknown;
      try {
        raw = encodeShellSnapshotRaw(typed);
      } catch {
        continue;
      }
      threads += typed.threads.length;
      counts[compareDecoded(raw)]++;
      counts[compareDecoded(reorder(raw))]++;
      counts[compareDecoded(perturb(raw))]++;
      // Present-undefined on optional thread keys still decodes, and the JSON
      // codec writes it as null.
      const withUndefined = structuredClone(raw) as { threads: Array<Record<string, unknown>> };
      withUndefined.threads.forEach((thread, index) => {
        for (const [keyIndex, key] of OPTIONAL_THREAD_KEYS.entries()) {
          if ((index + keyIndex) % 3 === 0) thread[key] = undefined;
        }
      });
      counts[compareDecoded(withUndefined)]++;
    }
    expect(counts["both-throw"]).toBe(0);
    expect(counts.match).toBeGreaterThanOrEqual(1_200);
    expect(threads).toBeGreaterThan(500);
  });

  it("leaves event items on the contract encoding", () => {
    const events = FastCheck.sample(Schema.toArbitrary(OrchestrationShellStreamEvent), {
      numRuns: 200,
      seed: 11,
    });
    let encoded = 0;
    for (const event of events) {
      const contract = attempt(() => chunkBytes(WsOrchestrationSubscribeShellRpc, [event]));
      const server = attempt(() => chunkBytes(WsServerSubscribeShellRpc, [event]));
      expect(server).toEqual(contract);
      if (contract.ok) encoded++;
    }
    expect(encoded).toBeGreaterThan(50);
  });
});
