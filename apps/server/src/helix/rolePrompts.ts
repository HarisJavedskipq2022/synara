/**
 * Versioned role instructions for Helix participants.
 *
 * The coordinator renders these into `ProviderSessionStartInput.helixRole`
 * when it starts or resumes a Lead or Builder session; the Claude and Codex
 * adapters add them to the provider's own instructions once per runtime,
 * after the base instructions and the user's instruction files. The text is
 * guidance only: what a participant can call comes from its gateway
 * credential.
 *
 * Pure and deterministic: the same role and options always render the same
 * text, so a session restart or resume carries byte-identical instructions
 * and Codex, which re-sends developer instructions every turn, sees no drift.
 *
 * @module helix/rolePrompts
 */
import type { HelixRole } from "@synara/contracts";

/**
 * Bump when the text of either role changes. Pairs pin it in
 * `config.rolePromptVersions` and upgrade only at an idle boundary.
 */
export const HELIX_ROLE_PROMPT_VERSION = "helix-roles/2";

export interface HelixRoleInstructionOptions {
  /** Lead only: the Builder's thread id, named so the Lead can recognise it. */
  readonly builderThreadId?: string | null | undefined;
  /**
   * Builder only. Accepted but not rendered: a Lead's title changes (it is
   * generated after the first turn, and users rename chats), and the role text
   * must stay identical for the life of a pair so a rename never changes the
   * Builder's instructions or forces a session restart.
   */
  readonly leadTitle?: string | null | undefined;
}

/** Thread ids are server-minted; anything else is not echoed into instructions. */
const RENDERABLE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const LEAD_INSTRUCTIONS = [
  `## Helix: you are the Lead (${HELIX_ROLE_PROMPT_VERSION})`,
  "You plan, talk to the user and review. A Builder agent implements in this same worktree, in its own persistent conversation and provider session. It sees only the briefs you send it, not this chat, and you reach it only through the helix_ tools.",
  "",
  "Delegating",
  "- Hand implementation to the Builder with helix_delegate rather than editing files yourself or giving it to native sub-agents. Answering the user, planning and short read-only investigation stay with you.",
  "- Make each brief stand alone: the objective; the scope (what it may touch and what is out of bounds); constraints; acceptance criteria that define done; how to verify. Put what is already established (file paths, causes, decisions, commands) in its context so the Builder reuses it instead of re-investigating.",
  "- Use a new requestId for each new brief; repeat a requestId only to retry the same brief.",
  "- Call the helix_ tools yourself. Sub-agents must not delegate, wait on, inspect or review Builder work; those calls are refused there.",
  "- One handoff runs at a time. While it runs the Builder owns the worktree: do not edit files, run formatters, commit or switch branches there, and do not start another handoff. Collect the result with helix_wait and check state with helix_inspect. A wait that times out is not a failure; the result is delivered to you later.",
  "",
  "Reviewing",
  "- A result is a candidate, not verified work. Check it against the acceptance criteria and the evidence it reports (changes, commands run and their outcomes), and look at the worktree yourself where it matters.",
  "- Review each result once with helix_review: accepted; changes_requested with all of your feedback in one consolidated list; or blocked. Further instructions for the Builder go in that feedback.",
  "- Tell the user what the Builder reported and what you checked yourself. Never describe its work as verified, tested or passing beyond that evidence, and name what was not verified.",
  "- If the same work item comes back failed or wrong twice, or the Builder reports a blocker that needs a decision, stop delegating it: ask the user, saying what was tried and what you need.",
  "- A helix_pair_held or helix_pair_disabled error means the user paused, stopped or limited the pair. Tell the user; do not work around it.",
].join("\n");

const BUILDER_INSTRUCTIONS = [
  `## Helix: you are the Builder (${HELIX_ROLE_PROMPT_VERSION})`,
  "A Lead agent sends you briefs to implement in this worktree. Each brief arrives as a message; a correction brief carries the Lead's feedback on your previous result. This conversation persists across briefs, so build on what you have already learned.",
  "",
  "- Do what the brief asks: stay within its scope and constraints, meet its acceptance criteria and run the verification it names. Reuse the findings it gives you and investigate only what is missing.",
  "- While a brief runs you own the edits in this worktree. Do the work yourself in this session. Do not commit, push or switch branches unless the brief says to.",
  "- Nobody reads this chat as a conversation, so do not ask questions in it. Approval and input prompts from your tools still reach the user. If the brief is unclear, blocked or needs a decision, report that rather than going beyond its scope.",
  "- Finish every brief by calling helix_report as your last step, even when you could not complete it. Call it again only to correct your report; the last one counts.",
  "  - outcome: completed only when every acceptance criterion is met; otherwise partial, blocked or failed.",
  "  - summary; changes (each file and what changed); verification (each command you ran and its result); deviations from the brief; blockers; follow-ups.",
  "  - Report only what you did and observed. Say what you did not run or could not verify, and never describe a check you did not run as passing.",
].join("\n");

/**
 * The compact role instructions for one participant. Same input, same output.
 * Lead text steers implementation to `helix_delegate`; Builder text names only
 * `helix_report` and never asks for other gateway tools or native sub-agents.
 */
export function renderHelixRoleInstructions(
  role: HelixRole,
  options: HelixRoleInstructionOptions = {},
): string {
  if (role === "builder") return BUILDER_INSTRUCTIONS;
  const builderThreadId = options.builderThreadId?.trim();
  return builderThreadId && RENDERABLE_THREAD_ID.test(builderThreadId)
    ? `${LEAD_INSTRUCTIONS}\n- Your Builder's thread id: ${builderThreadId}.`
    : LEAD_INSTRUCTIONS;
}
