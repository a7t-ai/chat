// Small "staging" pill, shown ONLY on the staging environment (driven by me.env from
// /api/me, so it's correct however you reach the app). Rendered next to the sidebar brand
// (desktop) and in the topbar (mobile) so it's visible in both layouts.
export function StagingBadge({ env, className }: { env?: string; className?: string }) {
  if (env !== "staging") return null;
  return (
    <span className={`staging-badge${className ? ` ${className}` : ""}`} title="Staging environment">
      staging
    </span>
  );
}
