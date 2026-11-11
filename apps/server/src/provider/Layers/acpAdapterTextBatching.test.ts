// FILE: acpAdapterTextBatching.test.ts
// Purpose: Each ACP adapter declares fresh-ids-once delivery, and the answer and
//          reasoning deltas it really streams pass the durable text-batch predicate.
// Layer: Provider adapter tests
// Note: mocks each adapter's ACP runtime factory with an in-memory session.

import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Acp from "@agentclientprotocol/sdk";
import { ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { Effect, Layer, Queue, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import type { AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";
import type { AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { makeFakeAcpSessionRuntime } from "../acp/testing/fakeAcpSessionRuntime.ts";
import { compatibleAssistantText, isBatchableAssistantText } from "../providerRuntimeTextBatch.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { DroidAdapter } from "../Services/DroidAdapter.ts";
import { GrokAdapter } from "../Services/GrokAdapter.ts";
import { OmpAdapter } from "../Services/OmpAdapter.ts";
import { makeCursorAdapterLive } from "./CursorAdapter.ts";
import { makeDroidAdapterLive } from "./DroidAdapter.ts";
import { makeGrokAdapterLive } from "./GrokAdapter.ts";
import { makeOmpAdapterLive } from "./OmpAdapter.ts";

// Each prompt streams two answer chunks and two reasoning chunks of one
// message, the shape `parseSessionUpdateEvent` produces for ACP chunks.
const fakeRuntime = vi.hoisted(() => ({
  factory: undefined as undefined | (() => unknown),
}));

vi.mock("../acp/CursorAcpSupport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/CursorAcpSupport.ts")>()),
  makeCursorAcpRuntime: () => fakeRuntime.factory!(),
}));
vi.mock("../acp/GrokAcpSupport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/GrokAcpSupport.ts")>()),
  makeGrokAcpRuntime: () => fakeRuntime.factory!(),
}));
vi.mock("../acp/DroidAcpSupport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/DroidAcpSupport.ts")>()),
  makeDroidAcpRuntime: () => fakeRuntime.factory!(),
}));
vi.mock("../acp/OmpAcpSupport.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../acp/OmpAcpSupport.ts")>()),
  makeOmpAcpRuntime: () => fakeRuntime.factory!(),
}));

function makeStreamingRuntime(): AcpSessionRuntimeShape {
  const events = Effect.runSync(Queue.unbounded<AcpParsedSessionEvent>());
  const chunk = (text: string, streamKind: "assistant_text" | "reasoning_text") =>
    Queue.offer(events, {
      _tag: "ContentDelta",
      itemId: streamKind === "assistant_text" ? "message-1" : "thought-1",
      text,
      streamKind,
      rawPayload: {
        sessionId: "acp-batching-session",
        update: {
          sessionUpdate:
            streamKind === "assistant_text" ? "agent_message_chunk" : "agent_thought_chunk",
          content: { type: "text", text },
        },
      },
    });
  const base = makeFakeAcpSessionRuntime({
    sessionId: "acp-batching-session",
    prompt: () =>
      Effect.gen(function* () {
        yield* chunk("Thinking ", "reasoning_text");
        yield* chunk("hard", "reasoning_text");
        yield* chunk("Hello ", "assistant_text");
        yield* chunk("world", "assistant_text");
        // Let the adapter drain the session updates before the turn ends.
        yield* Effect.sleep("50 millis");
        return { stopReason: "end_turn" } as Acp.PromptResponse;
      }),
  });
  return { ...base, getEvents: () => Stream.fromQueue(events) } as AcpSessionRuntimeShape;
}

type StreamingAdapter = {
  readonly runtimeEventDelivery?: "fresh-ids-once";
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
  readonly startSession: (input: never) => Effect.Effect<unknown, unknown>;
  readonly sendTurn: (input: never) => Effect.Effect<unknown, unknown>;
  readonly stopAll: () => Effect.Effect<void, unknown>;
};

const cases = [
  {
    provider: "cursor",
    service: CursorAdapter,
    layer: () => makeCursorAdapterLive(),
  },
  { provider: "grok", service: GrokAdapter, layer: () => makeGrokAdapterLive() },
  {
    provider: "droid",
    service: DroidAdapter,
    layer: () => makeDroidAdapterLive(),
  },
  { provider: "omp", service: OmpAdapter, layer: () => makeOmpAdapterLive() },
] as const;

describe("ACP adapter text batching", () => {
  it.each(cases)(
    "$provider streams answer and reasoning deltas the durable text batch can combine",
    async ({ provider, service, layer }) => {
      fakeRuntime.factory = () => Effect.sync(makeStreamingRuntime);
      const program = Effect.scoped(
        Effect.gen(function* () {
          const adapter = (yield* service) as unknown as StreamingAdapter;
          expect(adapter.runtimeEventDelivery).toBe("fresh-ids-once");
          const collected: ProviderRuntimeEvent[] = [];
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => Effect.sync(() => collected.push(event))),
            Effect.forkScoped,
          );
          const threadId = ThreadId.makeUnsafe(`thread-${provider}-text-batching`);
          yield* adapter.startSession({
            provider,
            threadId,
            runtimeMode: "full-access",
            cwd: process.cwd(),
          } as never);
          yield* adapter.sendTurn({
            threadId,
            input: "stream some text",
            attachments: [],
          } as never);
          yield* Effect.sleep("100 millis");
          yield* adapter.stopAll();
          return collected.filter((event) => event.type === "content.delta");
        }),
      );
      // The four adapter layers differ only in their service key.
      const adapterLayer = (layer() as unknown as Layer.Layer<never>).pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: `${provider}-text-batching-` }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );
      const deltas = await Effect.runPromise(
        program.pipe(Effect.provide(adapterLayer)) as Effect.Effect<
          ProviderRuntimeEvent[],
          unknown
        >,
      );

      for (const streamKind of ["assistant_text", "reasoning_text"] as const) {
        const ofKind = deltas.filter(
          (event) => event.type === "content.delta" && event.payload.streamKind === streamKind,
        );
        expect(
          ofKind.map((event) => event.type === "content.delta" && event.payload.delta),
        ).toEqual(streamKind === "assistant_text" ? ["Hello ", "world"] : ["Thinking ", "hard"]);
        const [first, second] = ofKind;
        if (!first || !isBatchableAssistantText(first)) {
          throw new Error(`Expected a batchable ${provider} ${streamKind} delta`);
        }
        expect(first.raw?.payload).toEqual({});
        expect(compatibleAssistantText(first, second!)).toBe(true);
      }
    },
  );
});
