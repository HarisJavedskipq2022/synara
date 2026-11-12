// FILE: HelixHandoffCard.tsx
// Purpose: One Lead → Builder handoff: the brief (objective, scope, done criteria),
//          its state and revision, the Builder's result (outcome, deviations, blockers,
//          evidence) and the Lead's verdict. The verdict is labelled as the Lead agent's
//          own judgement so it never reads as the user's review or approval.
// Layer: Chat Helix UI
// Exports: HelixHandoffCard

import type { HelixBuilderResult, HelixHandoff, HelixHold } from "@synara/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useTranslation } from "~/i18n";
import {
  helixHandoffStateLabelKey,
  helixHandoffStateTone,
  helixLateResultLabelKey,
  helixLateResultNoteKey,
  helixOutcomeLabelKey,
  helixOutcomeTone,
  helixVerdictLabelKey,
  isHelixCorrection,
} from "~/helix/helixPresentation";
import { BotIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { DisclosureChevron } from "../../ui/DisclosureChevron";
import { DisclosureRegion } from "../../ui/DisclosureRegion";
import { IconButton } from "../../ui/icon-button";
import { helixToneClassName } from "./helixTone";

function Field({ label, text }: { label: string; text: string | undefined }) {
  if (!text || text.trim().length === 0) return null;
  return (
    <div className="min-w-0">
      <p className="text-ui-xs font-medium text-muted-foreground">{label}</p>
      <p className="whitespace-pre-wrap break-words text-ui-sm text-foreground/85">{text}</p>
    </div>
  );
}

function Section({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-2 min-w-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <h4 className="text-ui-xs font-medium tracking-[0.04em] text-muted-foreground uppercase">
          {title}
        </h4>
        {trailing}
      </div>
      <div className="mt-1 space-y-1.5">{children}</div>
    </section>
  );
}

function ResultFields({ result }: { result: HelixBuilderResult }) {
  const { t } = useTranslation();
  return (
    <>
      {result.summary.trim().length > 0 ? (
        <p className="whitespace-pre-wrap break-words text-ui-sm text-foreground/85">
          {result.summary}
        </p>
      ) : null}
      {result.source === "final_message" ? (
        <p className="text-ui-xs text-muted-foreground">
          {t("chat:helix_result_fromFinalMessage")}
        </p>
      ) : result.source === "none" ? (
        <p className="text-ui-xs text-muted-foreground">{t("chat:helix_result_none")}</p>
      ) : null}
      <Field label={t("chat:helix_result_changes")} text={result.changes} />
      <Field label={t("chat:helix_result_evidence")} text={result.verification} />
      <Field label={t("chat:helix_result_deviations")} text={result.deviations} />
      <Field label={t("chat:helix_result_blockers")} text={result.blockers} />
      <Field label={t("chat:helix_result_followUps")} text={result.followUps} />
    </>
  );
}

export function HelixHandoffCard({
  handoff,
  pairHold,
  defaultExpanded,
  focused,
}: {
  handoff: HelixHandoff;
  /** The pair's hold: a restart hold leaves a running handoff running, result pending. */
  pairHold: HelixHold | null;
  defaultExpanded: boolean;
  /** Opened from the Lead's timeline: scrolled into view once. */
  focused: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const articleRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (focused) articleRef.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  const heldAfterRestart = pairHold?.kind === "restart" && handoff.state === "running";
  const { brief, result, review, lateResult, failure } = handoff;
  const stateTone = helixHandoffStateTone(handoff.state);
  const toggleLabel = expanded
    ? t("chat:helix_hideDetails", { value0: brief.title })
    : t("chat:helix_showDetails", { value0: brief.title });
  const metaParts = [
    t("chat:helix_handoffRevision", { value0: handoff.revision }),
    ...(result ? [t("chat:helix_resultRevision", { value0: result.revision })] : []),
  ];

  return (
    <article
      ref={articleRef}
      data-testid="helix-handoff-card"
      data-focused={focused ? "" : undefined}
      className={cn(
        "rounded-xl border bg-card/50 px-3 py-2",
        focused ? "border-ring/60" : "border-border/70",
      )}
      aria-label={t("chat:helix_handoffAria", { value0: handoff.sequence, value1: brief.title })}
    >
      <div className="flex min-w-0 items-center gap-2">
        <IconButton
          className="flex size-5 shrink-0 items-center justify-center text-muted-foreground"
          onClick={() => setExpanded(!expanded)}
          label={toggleLabel}
          aria-expanded={expanded}
        >
          <DisclosureChevron open={expanded} className="size-3" />
        </IconButton>
        <span className="shrink-0 tabular-nums text-ui-xs text-muted-foreground">
          {t("chat:helix_handoffNumber", { value0: handoff.sequence })}
        </span>
        <p className="min-w-0 flex-1 truncate text-ui font-medium" title={brief.title}>
          {brief.title}
        </p>
        {isHelixCorrection(handoff) ? (
          <span className="shrink-0 rounded-full border border-border/70 px-1.5 text-ui-xs text-muted-foreground">
            {t("chat:helix_correctionNumber", { value0: handoff.correctionIndex })}
          </span>
        ) : null}
        <span className={cn("shrink-0 text-ui-xs", helixToneClassName(stateTone))}>
          {t(helixHandoffStateLabelKey(handoff.state))}
        </span>
      </div>
      {heldAfterRestart ? (
        <p role="status" className="mt-1 text-ui-xs text-muted-foreground">
          {t("chat:helix_heldAfterRestartNote")}
        </p>
      ) : null}
      <DisclosureRegion open={expanded}>
        <p className="mt-1 text-ui-xs text-muted-foreground tabular-nums">
          {metaParts.join(" · ")}
        </p>
        <Section title={t("chat:helix_brief")}>
          <Field label={t("chat:helix_brief_objective")} text={brief.objective} />
          <Field label={t("chat:helix_brief_scope")} text={brief.scope} />
          <Field label={t("chat:helix_brief_acceptance")} text={brief.acceptanceCriteria} />
          <Field label={t("chat:helix_brief_constraints")} text={brief.constraints} />
          <Field label={t("chat:helix_brief_context")} text={brief.context} />
          <Field label={t("chat:helix_brief_verification")} text={brief.verification} />
          <Field label={t("chat:helix_brief_runtimeNotes")} text={brief.runtimeNotes} />
          <Field label={t("chat:helix_brief_correction")} text={brief.correction?.feedback} />
        </Section>
        {result ? (
          <Section
            title={t("chat:helix_result")}
            trailing={
              <span
                className={cn("text-ui-xs", helixToneClassName(helixOutcomeTone(result.outcome)))}
              >
                {t(helixOutcomeLabelKey(result.outcome))}
              </span>
            }
          >
            <ResultFields result={result} />
          </Section>
        ) : null}
        {failure ? (
          <Section title={t("chat:helix_failure")}>
            <p className="whitespace-pre-wrap break-words text-ui-sm text-foreground/85">
              {failure.reason}
            </p>
          </Section>
        ) : null}
        {lateResult ? (
          <Section
            title={t(helixLateResultLabelKey(handoff.lateResultReason))}
            trailing={
              <span className="text-ui-xs text-muted-foreground">
                {t(helixOutcomeLabelKey(lateResult.outcome))}
              </span>
            }
          >
            <p className="text-ui-xs text-muted-foreground">
              {t(helixLateResultNoteKey(handoff.lateResultReason))}
            </p>
            <ResultFields result={lateResult} />
          </Section>
        ) : null}
        {review ? (
          <section
            data-testid="helix-lead-verdict"
            className="mt-2 rounded-lg border border-[color:var(--color-border-light)] bg-[var(--color-background-elevated-primary)] px-2.5 py-2"
          >
            <div className="flex min-w-0 items-center gap-1.5 text-ui-sm">
              <BotIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="shrink-0 text-muted-foreground">{t("chat:helix_verdict")}</span>
              <span
                className={cn(
                  "min-w-0 truncate font-medium",
                  helixToneClassName(helixHandoffStateTone(handoff.state)),
                )}
              >
                {t(helixVerdictLabelKey(review.verdict))}
              </span>
            </div>
            {review.feedback.trim().length > 0 ? (
              <p className="mt-1 whitespace-pre-wrap break-words text-ui-sm text-foreground/85">
                {review.feedback}
              </p>
            ) : null}
            <p className="mt-1 text-ui-xs text-muted-foreground">{t("chat:helix_verdictNote")}</p>
          </section>
        ) : null}
      </DisclosureRegion>
    </article>
  );
}
