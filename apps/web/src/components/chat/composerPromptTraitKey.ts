// FILE: composerPromptTraitKey.ts
// Purpose: Reduces the composer prompt to the part trait resolution reads, so render paths
// that show traits (the model picker, the footer summary) change only when that part does,
// not on every keystroke.
// Layer: Chat composer state helpers
// Exports: composerPromptTraitKey, ComposerPromptTraitKey

import { isClaudeUltrathinkPrompt } from "@synara/shared/model";

/** A prompt as `getComposerTraitSelection` sees it: whether it carries the Ultrathink keyword. */
export type ComposerPromptTraitKey = "" | "ultrathink";

/**
 * `getComposerTraitSelection` reads the prompt only through `isClaudeUltrathinkPrompt`, so a
 * prompt and its key resolve to the same selection. Pass the key where a selection is
 * rendered and the real prompt (read when the handler runs) where it is rewritten, such as
 * `planComposerEffortChange`. If trait resolution starts reading more of the prompt, extend
 * the key; `composerPromptTraitKey.test.ts` compares the two selections.
 */
export function composerPromptTraitKey(prompt: string): ComposerPromptTraitKey {
  return isClaudeUltrathinkPrompt(prompt) ? "ultrathink" : "";
}
