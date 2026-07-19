import { Minimize2, X } from "lucide-react";
import type { ContextUsage } from "../lib/api";
import { useT } from "../lib/i18n";

// Compact conversation, context-aware (#38). A subtle affordance pinned just above the composer:
//   - once the thread fills enough of the active model's context window (`showMeter`), a thin usage
//     meter appears so the user can SEE the conversation getting long;
//   - near the limit (`shouldPrompt`), it expands into a dismissible nudge offering "Compact", which
//     folds the older turns into a summary so the chat keeps fitting the window.
// Design: this is deliberately NOT Clippy. It stays a quiet meter until usage is real, the nudge is
// dismissible, and compaction is always the USER's tap (never silent auto-compaction). The full
// transcript is preserved server-side — compaction only shrinks what the MODEL sees, so the copy
// says the history is kept.
export function CompactionBanner({
  context,
  dismissed,
  compacting,
  onCompact,
  onDismiss,
}: {
  context: ContextUsage;
  // Whether the user dismissed the near-limit nudge for this thread (the meter still shows).
  dismissed: boolean;
  // True while a compact request is in flight (disables the button, shows a working label).
  compacting: boolean;
  onCompact: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  // Nothing to show until the conversation is actually long enough — keep a short chat chrome-free.
  if (!context.showMeter) return null;

  const percent = Math.round(context.ratio * 100);
  const nudging = context.shouldPrompt && !dismissed;

  return (
    <section
      className={`compact-banner${nudging ? " compact-banner--nudge" : ""}`}
      aria-label={t("compact.title")}
    >
      <div className="compact-meter" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="compact-meter-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="compact-row">
        <span className="compact-usage muted small">{t("compact.usage", { percent })}</span>
        {nudging && (
          <>
            <span className="compact-msg small">{t("compact.nearLimit")}</span>
            <button
              type="button"
              className="compact-action"
              onClick={onCompact}
              disabled={compacting}
              title={t("compact.hint")}
            >
              <Minimize2 size={13} strokeWidth={2} aria-hidden="true" />
              <span>{compacting ? t("compact.working") : t("compact.action")}</span>
            </button>
            <button
              type="button"
              className="compact-dismiss"
              onClick={onDismiss}
              aria-label={t("compact.dismiss")}
              title={t("compact.dismiss")}
            >
              <X size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </section>
  );
}
