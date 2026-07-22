import { BarChart3, Brain, Fingerprint, FolderOpen, Info, Key, Keyboard, Share2, SlidersHorizontal, User, Users } from "lucide-react";
import type { Me } from "../lib/api";
import { useT } from "../lib/i18n";
import { SidebarModal, type SidebarModalItem } from "./ui";
import { AboutPanel } from "./AboutPanel";
import { BYOKPanel } from "./BYOKPanel";
import { DirectoryPanel } from "./DirectoryPanel";
import { FilesPanel } from "./FilesPanel";
import { KeyboardSheet } from "./KeyboardSheet";
import { MemoryPanel } from "./MemoryPanel";
import { PasskeysPanel } from "./PasskeysPanel";
import { ProfilePanel } from "./ProfilePanel";
import { SettingsPanel } from "./SettingsPanel";
import { SharedPanel } from "./SharedPanel";
import { StatsPanel } from "./StatsPanel";

export type AccountSection =
  | "profile"
  | "directory"
  | "settings"
  | "memory"
  | "passkeys"
  | "keys"
  | "keyboard"
  | "about"
  | "shared"
  | "files"
  | "stats";

// The admin-only sections, grouped at the foot of the rail. Email OTP + invites + the "email me
// when done" reminders + GDPR data-panel were removed (#169), and the passkey-account manager was
// removed (#179), so the admin group is now just the local telemetry dashboard.
const ADMIN_SECTIONS: readonly AccountSection[] = ["stats"];

// Consolidated account modal — replaces the linearly-growing account menu with ONE SidebarModal
// (the YouTube/ChatGPT settings pattern). The left rail lists every section (Profile … + an admin
// group for admins); the content pane renders the matching panel in `embedded` mode (body only —
// this modal owns the chrome). ChatView holds the `section` state and the compact menu that opens
// it. Only the active section mounts, so each panel fetches lazily exactly as its old dialog did.
export function AccountModal({
  me,
  section,
  onSection,
  onClose,
  onOpenConversation,
  onUserChange,
}: {
  me: Me;
  section: AccountSection;
  onSection: (s: AccountSection) => void;
  onClose: () => void;
  onOpenConversation: (id: string) => void;
  // Lets the Profile panel patch `me` in place (e.g. a new handle) so the account menu updates live.
  onUserChange?: (patch: Partial<Me["user"]>) => void;
}) {
  const t = useT();
  const isAdmin = me.role === "admin";

  const items: SidebarModalItem[] = [
    { id: "profile", label: t("nav.profile"), icon: User },
    { id: "directory", label: t("directory.title"), icon: Users },
    { id: "settings", label: t("nav.settings"), icon: SlidersHorizontal },
    { id: "memory", label: t("memory.title"), icon: Brain },
    // Passkeys only appear when the server has WebAuthn configured (#20) — dark otherwise.
    ...(me.passkeys?.available ? ([{ id: "passkeys", label: t("passkeys.title"), icon: Fingerprint }] satisfies SidebarModalItem[]) : []),
    { id: "keys", label: t("byok.title"), icon: Key },
    { id: "keyboard", label: t("nav.keyboard"), icon: Keyboard },
    { id: "shared", label: t("shared.menu"), icon: Share2 },
    { id: "files", label: t("files.title"), icon: FolderOpen },
    { id: "about", label: t("about.title"), icon: Info },
    ...(isAdmin
      ? ([{ id: "stats", label: t("nav.telemetry"), icon: BarChart3 }] satisfies SidebarModalItem[])
      : []),
  ];

  // Defensive: a non-admin can never reach an admin section (it's not in the rail / palette). Fall
  // back to Profile rather than render a panel that would 403 anyway.
  const outOfReach = !isAdmin && ADMIN_SECTIONS.includes(section);
  const active = outOfReach ? "profile" : section;
  const activeLabel = items.find((it) => it.id === active)?.label ?? "";

  return (
    <SidebarModal
      title={t("nav.settings")}
      items={items}
      activeId={active}
      onSelect={(id) => onSection(id as AccountSection)}
      onClose={onClose}
      closeLabel={t("common.close")}
    >
      <h3 className="account-section-heading">{activeLabel}</h3>
      {active === "profile" && <ProfilePanel embedded me={me} onClose={onClose} onUserChange={onUserChange} />}
      {active === "directory" && <DirectoryPanel embedded onClose={onClose} />}
      {active === "settings" && <SettingsPanel embedded onClose={onClose} />}
      {active === "memory" && <MemoryPanel embedded onClose={onClose} />}
      {active === "passkeys" && <PasskeysPanel embedded onClose={onClose} />}
      {active === "keys" && <BYOKPanel embedded me={me} onClose={onClose} />}
      {active === "keyboard" && <KeyboardSheet embedded onClose={onClose} />}
      {active === "about" && <AboutPanel embedded onClose={onClose} />}
      {active === "shared" && <SharedPanel embedded onClose={onClose} onOpen={onOpenConversation} />}
      {active === "files" && <FilesPanel embedded onClose={onClose} />}
      {active === "stats" && <StatsPanel embedded onClose={onClose} />}
    </SidebarModal>
  );
}
