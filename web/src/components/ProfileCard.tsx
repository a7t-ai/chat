import { Badge, type BadgeVariant } from "./ui";

// The plan tier's Badge variant — premium tiers (owner / plus / pro / ultra) read as accent, free as
// neutral. Exported so the design-system gallery can document the same badge the profile card uses.
const PLAN_VARIANT: Record<string, BadgeVariant> = {
  owner: "accent",
  ultra: "accent",
  pro: "accent",
  plus: "accent",
  free: "neutral",
};
export function planBadgeVariant(plan: string): BadgeVariant {
  return PLAN_VARIANT[plan] ?? "neutral";
}

// The account identity widget (avatar · name · email · plan badge) shown atop the Profile section.
// Extracted so the design-system gallery documents it AND the plan tier reads through the shared DS
// Badge instead of a bespoke `.plan-badge` pill.
export function ProfileCard({
  name,
  email,
  plan,
  planLabel,
}: {
  name: string;
  email?: string | null;
  plan: string;
  planLabel: string;
}) {
  const initial = (name || "?").charAt(0).toUpperCase();
  return (
    <div className="profile-card">
      <span className="profile-avatar" aria-hidden="true">
        {initial}
      </span>
      <div className="profile-ident">
        <span className="profile-name">{name}</span>
        {email && <span className="profile-email muted small">{email}</span>}
        <Badge variant={planBadgeVariant(plan)} className="profile-plan-badge">
          {planLabel}
        </Badge>
      </div>
    </div>
  );
}
