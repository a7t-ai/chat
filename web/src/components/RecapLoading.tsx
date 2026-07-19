import { History } from "lucide-react";
import { useT } from "../lib/i18n";

// Loading affordance for the on-demand `/recap` command (#37 follow-up). Pinned where the RecapCard
// will land while forceRecap runs, so the user sees the recap is coming instead of a blank
// several-second gap (the reported "nothing happened"). Reuses the RecapCard frame so it reads as
// "the recap, arriving". The icon gently pulses to signal work; the pulse is motion-gated in CSS
// (the app's data-motion="reduced" rule + the OS prefers-reduced-motion query leave a static icon).
// role="status" + aria-live="polite" announce "Recapping this conversation" to a screen reader.
export function RecapLoading() {
  const t = useT();
  return (
    <section className="recap-card recap-loading" role="status" aria-live="polite">
      <span className="recap-ico recap-loading-ico" aria-hidden="true">
        <History size={16} strokeWidth={1.75} />
      </span>
      <span className="recap-loading-label">{t("recap.loading")}</span>
    </section>
  );
}
