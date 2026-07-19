// The account button at the foot of the sidebar (avatar · name · role) — the trigger for the
// account menu. Extracted so the design-system gallery documents it; ChatView owns the popover.
export function AccountButton({
  name,
  role,
  label,
  expanded,
  onClick,
}: {
  name: string;
  role: string;
  label: string; // accessible name (the visible name/role are decorative for AT)
  expanded?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="account-btn"
      onClick={onClick}
      aria-label={label}
      aria-expanded={expanded}
      title={name}
    >
      <span className="menu-avatar">{name.charAt(0).toUpperCase()}</span>
      <span className="account-meta">
        <span className="account-name">{name}</span>
        <span className="account-role">{role}</span>
      </span>
    </button>
  );
}
