import type { ReactNode } from "react";

// ORGANISM · ChatBubble — one message in the conversation. The `user` role is a right-aligned filled
// bubble; the `assistant` role is a full-width block (markdown flows straight into it). Reuses the
// thread's `.msg` layout. Pair with <MessageActions> for the hover controls. Style: `.msg` / `.plain`.
export function ChatBubble({ role, children }: { role: "user" | "assistant"; children: ReactNode }) {
  return (
    <div className={role === "user" ? "msg user" : "msg"}>
      <div className={role === "user" ? "plain" : "msg-body"}>{children}</div>
    </div>
  );
}
