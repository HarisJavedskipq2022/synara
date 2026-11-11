import { Cause, Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ProviderRuntimeEventEnvelopeRow } from "../../persistence/Services/ProviderRuntimeEvents.ts";
import {
  ASSISTANT_SETTLING_SCAN_LIMIT,
  proveAssistantDeltaApplied,
  type AssistantDeltaProofInput,
} from "./ProviderRuntimeIngestion.replayProof.ts";

const input: AssistantDeltaProofInput = {
  eventId: "delta-a",
  threadId: "thread-1",
  turnId: "turn-1",
  itemId: "item-a",
  messageId: "assistant:item-a",
  runtimeSequence: 10,
};

const row = (
  sequence: number,
  eventType: string,
  extra: Partial<ProviderRuntimeEventEnvelopeRow> = {},
): ProviderRuntimeEventEnvelopeRow => ({
  sequence,
  eventId: `row-${sequence}`,
  eventType,
  turnId: "turn-1",
  itemId: null,
  itemType: null,
  ...extra,
});

function prove(options: {
  readonly receipts?: ReadonlyArray<string>;
  readonly rows?: ReadonlyArray<ProviderRuntimeEventEnvelopeRow>;
  readonly failRead?: boolean;
  readonly failReceipt?: boolean;
}) {
  const checked: string[] = [];
  const reads: Array<{ afterSequenceExclusive: number; scanLimit: number }> = [];
  const failures: Array<Cause.Cause<unknown>> = [];
  const result = Effect.runSync(
    proveAssistantDeltaApplied(
      {
        hasReceipt: (commandId) =>
          options.failReceipt
            ? Effect.fail(new Error("receipt store unavailable"))
            : Effect.sync(() => {
                checked.push(commandId);
                return options.receipts?.includes(commandId) ?? false;
              }),
        readEnvelopesAfter: (read) =>
          options.failRead
            ? Effect.fail(new Error("journal row unreadable"))
            : Effect.sync(() => {
                reads.push(read);
                return options.rows ?? [];
              }),
        commandId: (eventId, tag, target) => `${eventId}|${tag}|${target}`,
        onLookupFailure: (cause) => Effect.sync(() => void failures.push(cause)),
      },
      input,
    ),
  );
  return { result, checked, reads, failures };
}

describe("proveAssistantDeltaApplied", () => {
  it("accepts the delta's own streaming receipt without reading the journal", () => {
    const { result, reads } = prove({ receipts: ["delta-a|assistant-delta|assistant:item-a"] });
    expect(result).toBe(true);
    expect(reads).toEqual([]);
  });

  it("reads forward from the delta within a bounded scan", () => {
    const { reads } = prove({});
    expect(reads).toEqual([
      expect.objectContaining({
        afterSequenceExclusive: 10,
        scanLimit: ASSISTANT_SETTLING_SCAN_LIMIT,
      }),
    ]);
  });

  it("accepts the completion receipt of the next row that settles the message", () => {
    const { result, checked } = prove({
      rows: [row(11, "turn.completed"), row(12, "turn.started", { turnId: "turn-2" })],
      receipts: ["row-11|assistant-complete-finalize|assistant:item-a"],
    });
    expect(result).toBe(true);
    expect(checked.at(-1)).toBe("row-11|assistant-complete-finalize|assistant:item-a");
  });

  it("stops at the first deciding row without a receipt", () => {
    const { result, checked } = prove({
      rows: [
        row(11, "item.completed", { itemId: "item-a", itemType: "assistant_message" }),
        row(12, "turn.completed"),
      ],
      // A later receipt cannot exist if the deciding row never ran.
      receipts: ["row-12|assistant-complete-finalize|assistant:item-a"],
    });
    expect(result).toBe(false);
    expect(checked.some((commandId) => commandId.startsWith("row-12|"))).toBe(false);
  });

  it("keeps reading past rows that need not settle the message", () => {
    const { result } = prove({
      rows: [
        row(11, "turn.started", { turnId: "turn-2" }),
        row(12, "runtime.error", { turnId: null }),
        row(13, "turn.completed", { turnId: "turn-2" }),
        row(14, "turn.started", { turnId: "turn-3" }),
      ],
      // Late buffered text of turn-1 settles on a later turn boundary.
      receipts: ["row-14|assistant-complete-late|assistant:item-a"],
    });
    expect(result).toBe(true);
  });

  it("never takes another message's settle receipt as proof", () => {
    const { result, checked } = prove({
      rows: [
        // Message B of the same turn completes after A's delta.
        row(11, "item.completed", { itemId: "item-b", itemType: "assistant_message" }),
        row(12, "turn.started", { turnId: "turn-2" }),
      ],
      receipts: [
        "row-11|assistant-complete|assistant:item-b",
        "row-12|assistant-complete-late|assistant:item-b",
      ],
    });
    expect(result).toBe(false);
    // B's completion does not decide for A: the scan read on to the next row.
    expect(checked).toContain("row-12|assistant-complete-late|assistant:item-a");
  });

  it.each([
    ["the journal read", { failRead: true }],
    ["a receipt lookup", { failReceipt: true }],
  ] as const)("answers not proven when %s fails", (_name, failure) => {
    const { result, failures } = prove({ rows: [row(11, "turn.completed")], ...failure });
    expect(result).toBe(false);
    expect(failures).toHaveLength(1);
  });
});
