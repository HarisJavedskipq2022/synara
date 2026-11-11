import type { ProviderKind } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { composerPromptTraitKey } from "./composerPromptTraitKey";
import { getComposerTraitSelection } from "./composerTraits";
import { resolveTraitsTriggerSummary } from "./TraitsPicker";

const PROMPTS = [
  "",
  "f",
  "fix the flaky test",
  " ",
  "\n",
  "ultrathink",
  "Ultrathink:\nFix the flaky test",
  "please ULTRATHINK about this",
  "ultrathinking is not the keyword",
  "pasted\nmultiline\ntext with ultrathink inside\nand more",
  "/review",
  "@src/index.ts explain",
] as const;

const CASES: ReadonlyArray<{
  provider: ProviderKind;
  model: string;
  options: Record<string, unknown> | undefined;
}> = [
  { provider: "claudeAgent", model: "claude-opus-4-8", options: { effort: "low" } },
  { provider: "claudeAgent", model: "claude-opus-4-8", options: { effort: "ultrathink" } },
  { provider: "claudeAgent", model: "claude-opus-4-8", options: undefined },
  { provider: "codex", model: "gpt-5.5", options: { reasoningEffort: "high" } },
];

describe("composerPromptTraitKey", () => {
  it.each(CASES)("resolves the same trait selection as the full prompt ($provider $model)", (c) => {
    for (const prompt of PROMPTS) {
      const key = composerPromptTraitKey(prompt);
      expect(getComposerTraitSelection(c.provider, c.model, key, c.options as never)).toEqual(
        getComposerTraitSelection(c.provider, c.model, prompt, c.options as never),
      );
      const summaryInput = {
        provider: c.provider,
        model: c.model,
        modelOptions: c.options as never,
        runtimeAgents: null,
      };
      expect(resolveTraitsTriggerSummary({ ...summaryInput, prompt: key })).toEqual(
        resolveTraitsTriggerSummary({ ...summaryInput, prompt }),
      );
    }
  });

  it("tracks the Ultrathink lock in the same render as the text", () => {
    const lockedFor = (prompt: string) =>
      getComposerTraitSelection("claudeAgent", "claude-opus-4-8", composerPromptTraitKey(prompt), {
        effort: "low",
      }).ultrathinkPromptControlled;

    // Typing the keyword one character at a time locks only once the word is complete.
    const typed = "ultrathink";
    for (let length = 0; length < typed.length; length += 1) {
      expect(lockedFor(typed.slice(0, length))).toBe(false);
    }
    expect(lockedFor(typed)).toBe(true);
    // Deleting the last character or clearing the prompt releases it at once.
    expect(lockedFor(typed.slice(0, -1))).toBe(false);
    expect(lockedFor("")).toBe(false);
    // Pasting text that contains it locks in one step.
    expect(lockedFor("see notes\nultrathink\nthen fix")).toBe(true);
  });

  it("changes only when the keyword appears or disappears", () => {
    const keys = ["f", "fi", "fix", "fix ", "fix ultrathink", "fix ultrathin", "fix"].map(
      composerPromptTraitKey,
    );
    expect(keys).toEqual(["", "", "", "", "ultrathink", "", ""]);
  });
});
