import { Sparkles, X } from "lucide-react";
import type { SuggestionHint } from "../lib/api";
import { useT } from "../lib/i18n";

// The contextual-nudge chip (#22). Rendered below the latest reply when the exchange relates to a
// capability the caller isn't yet using (see web/src/lib/suggestions.ts for the matching). Subtle,
// informational, and DISMISSIBLE — the whole point is discoverability without nagging, so the copy
// is server-provided (English, alongside the capability) and the only action is "dismiss". The
// dismissal is remembered per-capability, so a dismissed nudge never returns.
export function CapabilitySuggestion({ hint, onDismiss }: { hint: SuggestionHint; onDismiss: () => void }) {
  const t = useT();
  return (
    <div className="cap-suggestion" role="note" aria-label={t("suggest.label")}>
      <span className="cap-suggestion-ico" aria-hidden="true">
        <Sparkles size={16} strokeWidth={1.75} />
      </span>
      <span className="cap-suggestion-text">
        <span className="cap-suggestion-title">{hint.title}</span>
        <span className="cap-suggestion-body muted">{hint.body}</span>
      </span>
      <button
        type="button"
        className="cap-suggestion-dismiss"
        onClick={onDismiss}
        aria-label={t("suggest.dismiss")}
        title={t("suggest.dismiss")}
      >
        <X size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
