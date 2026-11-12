import type { HelixHandoff } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { helixHandoffsByAnchorMessage } from "./HelixTimelineHandoffs";

const handoff = (id: string, sequence: number, leadTurnId: string | null | undefined) =>
  ({ id, sequence, leadTurnId }) as unknown as HelixHandoff;

const message = (id: string, role: "user" | "assistant", turnId: string | null) =>
  ({ id, role, turnId }) as never;

describe("helixHandoffsByAnchorMessage", () => {
  it("anchors each handoff at the last assistant message of its Lead turn", () => {
    const map = helixHandoffsByAnchorMessage(
      [handoff("h2", 2, "turn-a"), handoff("h1", 1, "turn-a"), handoff("h3", 3, "turn-b")],
      [
        message("u1", "user", "turn-a"),
        message("a1", "assistant", "turn-a"),
        message("a2", "assistant", "turn-a"),
        message("a3", "assistant", "turn-b"),
      ],
    );
    expect(map?.get("a2" as never)?.map((entry) => entry.id)).toEqual(["h1", "h2"]);
    expect(map?.get("a3" as never)?.map((entry) => entry.id)).toEqual(["h3"]);
    expect(map?.has("a1" as never)).toBe(false);
  });

  it("returns nothing when no handoff has a turn in the transcript", () => {
    expect(helixHandoffsByAnchorMessage([], [message("a", "assistant", "t")])).toBeUndefined();
    expect(
      helixHandoffsByAnchorMessage([handoff("h", 1, undefined)], [message("a", "assistant", "t")]),
    ).toBeUndefined();
    expect(
      helixHandoffsByAnchorMessage([handoff("h", 1, "gone")], [message("a", "assistant", "t")]),
    ).toBeUndefined();
  });
});
