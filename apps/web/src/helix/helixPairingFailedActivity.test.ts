import { EventId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { deriveWorkLogEntries } from "../workLog";

// The server appends this to a Lead's chat when a change that came with a message could
// not be applied after all; it must read as an ordinary error row with its reason.
describe("helix.pairing.failed activity", () => {
  it("renders as an error row with the server's reason", () => {
    const entries = deriveWorkLogEntries(
      [
        {
          id: EventId.makeUnsafe("pairing-failed-1"),
          tone: "error",
          kind: "helix.pairing.failed" as never,
          summary: "Helix change not applied",
          payload: { detail: "Helix could not record your change: disk full" },
          turnId: null,
          createdAt: "2026-11-12T00:00:00.000Z",
        },
      ],
      undefined,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      label: "Helix change not applied",
      tone: "error",
      detail: "Helix could not record your change: disk full",
    });
  });
});
