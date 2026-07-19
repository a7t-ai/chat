import { MessageCircleDashed } from "lucide-react";

// The temporary (ghost) chat glyph: a dashed speech bubble — the "ephemeral / nothing is
// kept" cue. A thin wrapper over Lucide's MessageCircleDashed so the topbar toggle, the
// banner, and the empty state all share one icon at a caller-chosen size.
export function TempChatIcon({ size = 18, className }: { size?: number; className?: string }) {
  return <MessageCircleDashed size={size} strokeWidth={1.75} className={className} aria-hidden="true" />;
}
