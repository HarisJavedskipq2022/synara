// FILE: helixDraftStore.ts
// Purpose: The Helix choice a composer holds until its next message. Touching the Helix
//          control records a choice for that chat's draft (new or existing chat); the
//          next user message carries it as `helix` on `thread.turn.start` (only to a
//          server advertising `helix.message-pairing`) and the server applies it. Until
//          touched, a chat shows its actual pairing. Also remembers the last Builder the
//          user chose (localStorage) so a new chat turns Helix on in one click, and keeps
//          the calm "Helix was not applied" note a sent message may come back with.
// Layer: Web Helix data (zustand)
// Exports: useHelixDraftStore, setHelixDraftChoice, clearHelixDraftChoice,
//          resolveHelixControlState, resolveHelixMessagePairing, recordHelixPairingOutcome,
//          dismissHelixPairingNote, onHelixPairingSettled, attachHelixMessagePairing,
//          readRememberedHelixBuilder, rememberHelixBuilder, defaultHelixBuilder

import {
  DEFAULT_MODEL_BY_PROVIDER,
  HelixMessagePairing,
  ModelSelection,
  type HelixPairingNotAppliedReason,
  type HelixPairingOutcome,
  type HelixPendingChange,
  type NativeApi,
  type ProviderKind,
} from "@synara/contracts";
import { Schema } from "effect";
import { create } from "zustand";

export interface HelixPairingNote {
  readonly reason: HelixPairingNotAppliedReason | null;
  /** The server's own sentence, shown only when the reason is unknown to this client. */
  readonly message: string | null;
  /** What the message asked for, so the note can say "turn on" or "turn off". */
  readonly enabled: boolean;
}

export interface HelixDraftState {
  /** A touched choice per chat (draft thread id = the thread it becomes). */
  readonly choiceByThreadId: ReadonlyMap<string, HelixMessagePairing>;
  readonly choiceMetaByThreadId: ReadonlyMap<string, HelixDraftChoiceMeta>;
  readonly noteByThreadId: ReadonlyMap<string, HelixPairingNote>;
}

// Choices outlive a reload like the rest of the draft (the worktree switch Helix made does),
// but not forever: see `staleHelixDraftChoices`. The key is versioned by shape, so a
// choice is never read back by a build that stores a different one (v1 had no metadata).
export const HELIX_DRAFT_CHOICES_STORAGE_KEY = "synara:helix:draft-choices:v2";
const RETIRED_DRAFT_CHOICES_STORAGE_KEYS = ["synara:helix:draft-choices:v1"];
/** An unsent choice older than this no longer reflects what the user is about to send. */
export const HELIX_DRAFT_CHOICE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface HelixDraftChoiceMeta {
  /** When the user made the choice. */
  readonly savedAt: number;
  /** The pair the chat had then (null for a chat without one). */
  readonly pairId: string | null;
}

const StoredChoice = Schema.Struct({
  choice: HelixMessagePairing,
  savedAt: Schema.Number,
  pairId: Schema.NullOr(Schema.String),
});
const decodeStoredChoices = Schema.decodeUnknownOption(
  Schema.Array(Schema.Tuple([Schema.String, StoredChoice])),
);

interface StoredChoices {
  readonly choices: ReadonlyMap<string, HelixMessagePairing>;
  readonly meta: ReadonlyMap<string, HelixDraftChoiceMeta>;
}

function readStoredChoices(now = Date.now()): StoredChoices {
  const choices = new Map<string, HelixMessagePairing>();
  const meta = new Map<string, HelixDraftChoiceMeta>();
  try {
    for (const key of RETIRED_DRAFT_CHOICES_STORAGE_KEYS) {
      globalThis.localStorage?.removeItem(key);
    }
    const raw = globalThis.localStorage?.getItem(HELIX_DRAFT_CHOICES_STORAGE_KEY);
    const decoded = raw ? decodeStoredChoices(JSON.parse(raw)) : null;
    if (decoded?._tag === "Some") {
      for (const [threadId, entry] of decoded.value) {
        if (now - entry.savedAt > HELIX_DRAFT_CHOICE_MAX_AGE_MS) continue;
        choices.set(threadId, entry.choice);
        meta.set(threadId, { savedAt: entry.savedAt, pairId: entry.pairId });
      }
    }
  } catch {
    // Unreadable or blocked storage: start without stored choices.
  }
  return { choices, meta };
}

function writeStoredChoices(state: HelixDraftState): void {
  try {
    if (state.choiceByThreadId.size === 0) {
      globalThis.localStorage?.removeItem(HELIX_DRAFT_CHOICES_STORAGE_KEY);
      return;
    }
    const entries = [...state.choiceByThreadId].map(([threadId, choice]) => {
      const meta = state.choiceMetaByThreadId.get(threadId);
      return [
        threadId,
        { choice, savedAt: meta?.savedAt ?? Date.now(), pairId: meta?.pairId ?? null },
      ] as const;
    });
    globalThis.localStorage?.setItem(HELIX_DRAFT_CHOICES_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Storage blocked or full: the choice still holds until the page reloads.
  }
}

const stored = readStoredChoices();

export const useHelixDraftStore = create<HelixDraftState>(() => ({
  choiceByThreadId: stored.choices,
  choiceMetaByThreadId: stored.meta,
  noteByThreadId: new Map(),
}));

useHelixDraftStore.subscribe((state, previous) => {
  if (state.choiceByThreadId !== previous.choiceByThreadId) writeStoredChoices(state);
});

function withEntry<V>(map: ReadonlyMap<string, V>, key: string, value: V | null) {
  const next = new Map(map);
  if (value === null) next.delete(key);
  else next.set(key, value);
  return next;
}

/** Record what the user chose in this chat's Helix control. Touching it clears an old note. */
const decodeMessagePairing = Schema.decodeUnknownOption(HelixMessagePairing);

/**
 * The choice as the contract shapes it: picker rows hand over UI model objects, and
 * decoding keeps only the contract's fields (the server stores what it receives).
 */
export function toContractHelixPairing(choice: HelixMessagePairing): HelixMessagePairing {
  const decoded = decodeMessagePairing(choice);
  return decoded._tag === "Some" ? decoded.value : choice;
}

export function setHelixDraftChoice(
  threadId: string,
  input: HelixMessagePairing,
  options: { readonly pairId?: string | null; readonly now?: number } = {},
): void {
  const choice = toContractHelixPairing(input);
  const meta: HelixDraftChoiceMeta = {
    savedAt: options.now ?? Date.now(),
    pairId: options.pairId ?? null,
  };
  useHelixDraftStore.setState((state) => ({
    choiceByThreadId: withEntry(state.choiceByThreadId, threadId, choice),
    choiceMetaByThreadId: withEntry(state.choiceMetaByThreadId, threadId, meta),
    noteByThreadId: state.noteByThreadId.has(threadId)
      ? withEntry(state.noteByThreadId, threadId, null)
      : state.noteByThreadId,
  }));
  if (choice.enabled) rememberHelixBuilder(choice.builderModelSelection);
}

/**
 * Drop the chat's choice. With `ifSame`, only when it is still that exact choice: a
 * message in flight must not wipe a newer choice the user made meanwhile.
 */
export function clearHelixDraftChoice(threadId: string, ifSame?: HelixMessagePairing): void {
  const current = useHelixDraftStore.getState().choiceByThreadId.get(threadId);
  if (current === undefined || (ifSame !== undefined && current !== ifSame)) return;
  useHelixDraftStore.setState((state) => ({
    choiceByThreadId: withEntry(state.choiceByThreadId, threadId, null),
    choiceMetaByThreadId: withEntry(state.choiceMetaByThreadId, threadId, null),
  }));
}

/** Resume means "keep going": it takes back an unsent "turn off" for that chat. */
export function clearPendingHelixTurnOff(threadId: string): void {
  if (useHelixDraftStore.getState().choiceByThreadId.get(threadId)?.enabled === false) {
    clearHelixDraftChoice(threadId);
  }
}

/** What the chat's pairing is now, as far as the client knows. */
export interface HelixActualPairing {
  readonly pairId: string;
  readonly active: boolean;
  /** Null while the pair's view has not loaded. */
  readonly builder: ModelSelection | null;
  readonly pendingChange: HelixPendingChange | null;
}

/**
 * Stored choices that no longer mean anything, so they are dropped rather than shown or
 * sent: older than a day; made for a pair that has since been removed or replaced; equal
 * to the chat's actual pairing (turned off elsewhere, or back to the same Builder); or for
 * a chat that no longer exists. A choice for a chat whose pairing is unknown yet stays.
 */
export function staleHelixDraftChoices(input: {
  readonly choices: ReadonlyMap<string, HelixMessagePairing>;
  readonly meta: ReadonlyMap<string, HelixDraftChoiceMeta>;
  readonly now: number;
  /** Known pairs by Lead thread; only consulted when `pairsKnown`. */
  readonly pairs: ReadonlyMap<string, HelixActualPairing>;
  readonly pairsKnown: boolean;
  /** False when the chat is known to be gone; undefined when it cannot be told yet. */
  readonly chatExists: (threadId: string) => boolean | undefined;
}): string[] {
  const stale: string[] = [];
  for (const [threadId, choice] of input.choices) {
    const meta = input.meta.get(threadId);
    if (meta && input.now - meta.savedAt > HELIX_DRAFT_CHOICE_MAX_AGE_MS) {
      stale.push(threadId);
      continue;
    }
    if (input.chatExists(threadId) === false) {
      stale.push(threadId);
      continue;
    }
    if (!input.pairsKnown) continue;
    const pair = input.pairs.get(threadId) ?? null;
    if (meta?.pairId != null && pair?.pairId !== meta.pairId) {
      stale.push(threadId);
      continue;
    }
    const pending = pair?.active ? pair.pendingChange : null;
    if (!choice.enabled && !pair?.active && pending === null) {
      stale.push(threadId);
      continue;
    }
    if (
      choice.enabled &&
      pair?.active &&
      pending === null &&
      pair.builder !== null &&
      modelSelectionsMatch(choice.builderModelSelection, pair.builder)
    ) {
      stale.push(threadId);
    }
  }
  return stale;
}

function modelSelectionsMatch(left: ModelSelection, right: ModelSelection): boolean {
  return (
    JSON.stringify(toContractHelixPairing({ enabled: true, builderModelSelection: left })) ===
    JSON.stringify(toContractHelixPairing({ enabled: true, builderModelSelection: right }))
  );
}

export function dropHelixDraftChoices(threadIds: readonly string[]): void {
  if (threadIds.length === 0) return;
  useHelixDraftStore.setState((state) => {
    const choices = new Map(state.choiceByThreadId);
    const meta = new Map(state.choiceMetaByThreadId);
    for (const threadId of threadIds) {
      choices.delete(threadId);
      meta.delete(threadId);
    }
    return { choiceByThreadId: choices, choiceMetaByThreadId: meta };
  });
}

export function dismissHelixPairingNote(threadId: string): void {
  if (!useHelixDraftStore.getState().noteByThreadId.has(threadId)) return;
  useHelixDraftStore.setState((state) => ({
    noteByThreadId: withEntry(state.noteByThreadId, threadId, null),
  }));
}

/**
 * The pairing a user message to `threadId` carries: the touched choice, and only when
 * the server advertises `helix.message-pairing`. Undefined otherwise (no change).
 */
export function resolveHelixMessagePairing(input: {
  readonly choice: HelixMessagePairing | undefined;
  readonly capabilityAdvertised: boolean;
}): HelixMessagePairing | undefined {
  return input.capabilityAdvertised ? input.choice : undefined;
}

type HelixPairingSettledListener = (threadId: string) => Promise<void>;
const settledListeners = new Set<HelixPairingSettledListener>();

/** Reload pair state once a message's pairing took effect (registered by helixSync). */
export function onHelixPairingSettled(listener: HelixPairingSettledListener): () => void {
  settledListeners.add(listener);
  return () => settledListeners.delete(listener);
}

/**
 * Apply the server's answer to a message that carried `sent`. The choice is consumed
 * either way (the message was sent); a `not_applied` answer leaves a note. Any other answer
 * keeps the choice on screen until the pair state has been reloaded, so the control does
 * not flicker back to the old pairing in between (and shows no note).
 */
export async function recordHelixPairingOutcome(
  threadId: string,
  sent: HelixMessagePairing,
  outcome: HelixPairingOutcome | undefined,
): Promise<void> {
  // `unchanged` too: a retried message reports it when its first attempt already applied
  // the change, and the pair state on screen may still predate that.
  if (
    outcome?.status === "applied" ||
    outcome?.status === "pending" ||
    outcome?.status === "unchanged"
  ) {
    await Promise.allSettled([...settledListeners].map((listener) => listener(threadId)));
  }
  clearHelixDraftChoice(threadId, sent);
  if (outcome?.status !== "not_applied") return;
  const note: HelixPairingNote = {
    reason: outcome.reason ?? null,
    message: outcome.message ?? null,
    enabled: sent.enabled,
  };
  useHelixDraftStore.setState((state) => ({
    noteByThreadId: withEntry(state.noteByThreadId, threadId, note),
  }));
}

type DispatchableCommand = Parameters<NativeApi["orchestration"]["dispatchCommand"]>[0];

/**
 * Add the chat's touched Helix choice to a user message (`thread.turn.start`, not an
 * answer to a question; `thread.message.edit-and-resend`). Every send path (composer,
 * queued, steered, new chat, plan follow-up) dispatches through here, so each carries
 * the choice the composer held when it went out. Returns the pairing it attached.
 */
export function attachHelixMessagePairing(
  command: DispatchableCommand,
  capabilityAdvertised: boolean,
): { readonly command: DispatchableCommand; readonly pairing: HelixMessagePairing | undefined } {
  const carriesMessage =
    (command.type === "thread.turn.start" && command.asyncUserInputResponse === undefined) ||
    command.type === "thread.message.edit-and-resend";
  if (!carriesMessage || command.helix !== undefined) return { command, pairing: undefined };
  const pairing = resolveHelixMessagePairing({
    choice: useHelixDraftStore.getState().choiceByThreadId.get(command.threadId),
    capabilityAdvertised,
  });
  return pairing ? { command: { ...command, helix: pairing }, pairing } : { command, pairing };
}

export interface HelixControlState {
  readonly on: boolean;
  /** The Builder the pill names: chosen, pending, or configured. Null when unknown. */
  readonly builder: ModelSelection | null;
  /** The user touched the control; the next message carries the choice. */
  readonly touched: boolean;
  /** The server holds a change until the Builder finishes. */
  readonly pending: boolean;
}

/** What the control shows: the touched choice, else the server's pending change, else the pair. */
export function resolveHelixControlState(input: {
  readonly choice: HelixMessagePairing | undefined;
  readonly pairActive: boolean;
  readonly configuredBuilder: ModelSelection | null;
  readonly pendingChange: HelixPendingChange | null | undefined;
}): HelixControlState {
  if (input.choice !== undefined) {
    return {
      on: input.choice.enabled,
      builder: input.choice.enabled ? input.choice.builderModelSelection : null,
      touched: true,
      pending: false,
    };
  }
  const pending = input.pairActive ? (input.pendingChange ?? null) : null;
  if (pending !== null) {
    return {
      on: pending.kind !== "disable",
      builder: pending.kind === "builder" ? pending.builderModelSelection : input.configuredBuilder,
      touched: false,
      pending: true,
    };
  }
  return {
    on: input.pairActive,
    builder: input.pairActive ? input.configuredBuilder : null,
    touched: false,
    pending: false,
  };
}

// ── Remembered Builder lineup ─────────────────────────────────────────

export const HELIX_LAST_BUILDER_STORAGE_KEY = "synara:helix:last-builder:v1";

const decodeModelSelection = Schema.decodeUnknownOption(ModelSelection);

export function readRememberedHelixBuilder(): ModelSelection | null {
  try {
    const raw = globalThis.localStorage?.getItem(HELIX_LAST_BUILDER_STORAGE_KEY);
    if (!raw) return null;
    const decoded = decodeModelSelection(JSON.parse(raw));
    return decoded._tag === "Some" ? decoded.value : null;
  } catch {
    return null;
  }
}

export function rememberHelixBuilder(selection: ModelSelection): void {
  try {
    globalThis.localStorage?.setItem(HELIX_LAST_BUILDER_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // Storage full or blocked: the next chat starts from the default instead.
  }
}

/**
 * The Builder a one-click "turn on" uses: the last one chosen, else this chat's own
 * model when its provider may build, else Codex's default. Restricted providers skip.
 */
export function defaultHelixBuilder(input: {
  readonly remembered: ModelSelection | null;
  readonly chatSelection: ModelSelection | null;
  readonly restrictions: Partial<Record<ProviderKind, string>>;
}): ModelSelection | null {
  for (const candidate of [input.remembered, input.chatSelection]) {
    if (candidate && input.restrictions[candidate.provider] === undefined) return candidate;
  }
  for (const provider of ["codex", "claudeAgent"] as const) {
    if (input.restrictions[provider] === undefined) {
      return { provider, model: DEFAULT_MODEL_BY_PROVIDER[provider] } as ModelSelection;
    }
  }
  return null;
}
