// FILE: HelixTimelineHandoffs.tsx
// Purpose: Compact handoff cards in a Lead chat's transcript, under the Lead turn that
//          created each handoff (`leadTurnId`): the title, the objective, the state and
//          the Lead's verdict, with a button that opens the full card in the Helix panel.
//          Chats without a pair get no map at all, so ordinary timeline rows do no work.
// Layer: Chat Helix UI
// Exports: HelixTimelineHandoffs, useHelixTimelineHandoffs, helixHandoffsByAnchorMessage

import type { HelixHandoff, MessageId, ThreadId } from "@synara/contracts";
import { useMemo } from "react";

import { useTranslation } from "~/i18n";
import {
  helixHandoffStateLabelKey,
  helixHandoffStateTone,
  helixVerdictLabelKey,
} from "~/helix/helixPresentation";
import { useHelixStore } from "~/helix/helixStore";
import { useHelixEnabled } from "~/helix/useHelix";
import { ArrowUpRightIcon, HandoffIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { ChatMessage } from "../../../types";
import { Button } from "../../ui/button";
import { openHelixPanel } from "./helixPanelStore";
import { helixToneClassName } from "./helixTone";

const EMPTY_HANDOFFS: readonly HelixHandoff[] = [];

/**
 * Anchor each handoff at the last assistant message of its Lead turn. Handoffs without
 * a turn (older rows) or whose turn is not in the transcript stay in the panel only.
 * Oldest first within a turn, as they were created.
 */
export function helixHandoffsByAnchorMessage(
  handoffs: readonly HelixHandoff[],
  messages: readonly Pick<ChatMessage, "id" | "role" | "turnId">[],
): ReadonlyMap<MessageId, readonly HelixHandoff[]> | undefined {
  if (handoffs.length === 0) return undefined;
  const turnIds = new Set<string>();
  for (const handoff of handoffs) {
    if (handoff.leadTurnId) turnIds.add(handoff.leadTurnId);
  }
  if (turnIds.size === 0) return undefined;
  const anchorByTurn = new Map<string, MessageId>();
  for (const message of messages) {
    if (message.role === "assistant" && message.turnId && turnIds.has(message.turnId)) {
      anchorByTurn.set(message.turnId, message.id);
    }
  }
  const byMessage = new Map<MessageId, HelixHandoff[]>();
  for (const handoff of handoffs.toSorted((left, right) => left.sequence - right.sequence)) {
    const anchor = handoff.leadTurnId ? anchorByTurn.get(handoff.leadTurnId) : undefined;
    if (!anchor) continue;
    const list = byMessage.get(anchor) ?? [];
    list.push(handoff);
    byMessage.set(anchor, list);
  }
  return byMessage.size > 0 ? byMessage : undefined;
}

/** The map the transcript reads; undefined (and no work) for a chat without a pair. */
export function useHelixTimelineHandoffs(
  threadId: ThreadId | null,
  messages: readonly ChatMessage[] | undefined,
): ReadonlyMap<MessageId, readonly HelixHandoff[]> | undefined {
  const enabled = useHelixEnabled();
  const handoffs = useHelixStore((state) => {
    if (!enabled || !threadId) return EMPTY_HANDOFFS;
    const detail = state.detailByLeadThreadId.get(threadId);
    return detail?.view?.pair.lifecycle === "active" ? detail.view.handoffs : EMPTY_HANDOFFS;
  });
  return useMemo(
    () =>
      handoffs === EMPTY_HANDOFFS || !messages
        ? undefined
        : helixHandoffsByAnchorMessage(handoffs, messages),
    [handoffs, messages],
  );
}

function HelixTimelineHandoffCard({
  handoff,
  leadThreadId,
}: {
  handoff: HelixHandoff;
  leadThreadId: ThreadId;
}) {
  const { t } = useTranslation();
  const verdict = handoff.review?.verdict ?? null;
  const tone = helixToneClassName(helixHandoffStateTone(handoff.state));
  return (
    <article
      data-testid="helix-timeline-handoff"
      className="rounded-xl border border-border/70 bg-card/50 px-3 py-2"
      aria-label={t("chat:helix_handoffAria", {
        value0: handoff.sequence,
        value1: handoff.brief.title,
      })}
    >
      <div className="flex min-w-0 items-center gap-2">
        <HandoffIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          {t("chat:helix_timelineHandoff")}
        </span>
        <span className="shrink-0 tabular-nums text-ui-xs text-muted-foreground">
          {t("chat:helix_handoffNumber", { value0: handoff.sequence })}
        </span>
        <p className="min-w-0 flex-1 truncate text-ui font-medium" title={handoff.brief.title}>
          {handoff.brief.title}
        </p>
        <span className={cn("shrink-0 text-ui-xs", tone)}>
          {verdict ? t(helixVerdictLabelKey(verdict)) : t(helixHandoffStateLabelKey(handoff.state))}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-ui-sm text-muted-foreground">
        {handoff.brief.objective}
      </p>
      <div className="mt-1 flex justify-end">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="h-6 gap-1 px-1.5 text-ui-sm text-muted-foreground hover:text-foreground"
          aria-label={t("chat:helix_openHandoffAria", { value0: handoff.sequence })}
          onClick={() => openHelixPanel(leadThreadId, handoff.id)}
        >
          {t("chat:helix_openHandoff")}
          <ArrowUpRightIcon className="size-3" aria-hidden="true" />
        </Button>
      </div>
    </article>
  );
}

export function HelixTimelineHandoffs({
  handoffs,
  leadThreadId,
}: {
  handoffs: readonly HelixHandoff[];
  leadThreadId: ThreadId;
}) {
  return (
    <div className="mt-2 flex flex-col gap-2">
      {handoffs.map((handoff) => (
        <HelixTimelineHandoffCard key={handoff.id} handoff={handoff} leadThreadId={leadThreadId} />
      ))}
    </div>
  );
}
