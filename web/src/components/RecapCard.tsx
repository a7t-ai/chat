import { ArrowRight, History, X } from "lucide-react";
import type { Recap } from "../lib/api";
import { useT } from "../lib/i18n";

// Archivist: conversation recap on return (#37) - "where you left off". Rendered at the bottom of a
// conversation you re-opened after time away (the server gates it on staleness + length), as the
// newest entry in the thread — so a /recap run from the composer lands where you are, and you can
// reconstruct context in seconds. Dismissible; the dismissal is remembered per conversation until
// new activity mints a fresh recap.
//
// Design - three presentations were explored, one chosen (the issue's design mandate):
//   1. SECTIONED CARD (chosen) - a titled card with the topic, a short "Progress" list, a "Where
//      it ended" line, and an optional "next step" resume affordance. Maps 1:1 to the recap's
//      fixed JSON shape, scans top-to-bottom, reuses the app's card/typography tokens, and reads
//      well on a phone. No ambiguity about interactivity.
//   2. TIMELINE - progress as a vertical dotted timeline ending at "where it ended". More visual,
//      but the progress points are NOT time-ordered events, so a timeline implies a chronology the
//      data doesn't carry, and it's heavier on small screens. Rejected.
//   3. RESUME-CHECKLIST - progress as checked-off items with the next step as the one open box.
//      Cute, but it collides with the real interactive TODO-checkbox primitive (#45/#131) and
//      implies a toggleable/actionable state the recap doesn't own. Misleading. Rejected.
export function RecapCard({
  recap,
  onDismiss,
  onResume,
}: {
  recap: Recap;
  onDismiss: () => void;
  // Seed the composer with the suggested next step so the user can resume in one tap. Optional:
  // when absent (or the recap has no next step), the next step reads as plain guidance.
  onResume?: (text: string) => void;
}) {
  const t = useT();
  return (
    <section className="recap-card" aria-label={t("recap.title")}>
      <header className="recap-head">
        <span className="recap-ico" aria-hidden="true">
          <History size={16} strokeWidth={1.75} />
        </span>
        <span className="recap-title">{t("recap.title")}</span>
        <button
          type="button"
          className="recap-dismiss"
          onClick={onDismiss}
          aria-label={t("recap.dismiss")}
          title={t("recap.dismiss")}
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </header>

      <p className="recap-topic">{recap.topic}</p>

      <div className="recap-section">
        <h4 className="recap-label">{t("recap.progress")}</h4>
        <ul className="recap-progress">
          {recap.progress.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      </div>

      <div className="recap-section">
        <h4 className="recap-label">{t("recap.whereItEnded")}</h4>
        <p className="recap-ended">{recap.whereItEnded}</p>
      </div>

      {recap.nextStep && (
        <div className="recap-section">
          <h4 className="recap-label">{t("recap.nextStep")}</h4>
          <p className="recap-next">{recap.nextStep}</p>
          {onResume && (
            <button type="button" className="recap-resume" onClick={() => onResume(recap.nextStep!)}>
              <span>{t("recap.resume")}</span>
              <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
