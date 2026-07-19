// Pure, deterministic mapping from "what went wrong" to a user-facing message key. The
// chat transport (chat.ts) reports errors as structured ErrorInfo (an HTTP status, a
// server message, a network flag, or a mid-stream kind) rather than a raw string; the UI
// runs errorKey() over it and renders the in-voice copy via t(). Keeping this a pure
// function (no React, no i18n runtime) is what lets it be exhaustively unit-tested — every
// branch below has a test in errors.test.ts.

import type { MessageKey } from "./i18n";

// A classified failure from a chat request. All fields optional: the caller fills in
// whatever it learned (a transport status, the parsed `{error}`/`{message}` body, a
// network flag, or `kind: "stream"` for an SSE `error` frame mid-generation).
export interface ErrorInfo {
  status?: number;
  serverMessage?: string;
  network?: boolean;
  kind?: "stream";
}

// True when a thrown value looks like a fetch transport failure (offline, DNS, CORS,
// connection reset). Browsers throw a TypeError for these; the message text varies by
// engine ("Failed to fetch" / "NetworkError" / "Load failed"), so match both.
export function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /failed to fetch|network|load failed/i.test(msg);
}

// Map a classified failure to the message key whose copy we show behind the ⚠️. Order
// matters: network beats everything (we never reached the server), then the specific HTTP
// statuses, then the mid-stream kind, then a generic catch-all (covers 400 and anything
// unrecognized).
export function errorKey(info: ErrorInfo): MessageKey {
  if (info.network) return "error.network";
  const status = info.status;
  if (status === 429) {
    // The server reuses 429 for two distinct cases: a real rate limit, and "a generation
    // is already in progress". Disambiguate on the server's own message.
    return info.serverMessage?.includes("in progress") ? "error.generating" : "error.rateLimit";
  }
  if (status === 402) return "error.usageLimit";
  if (status === 401) return "error.session";
  if (status === 403) return "error.notAvailable";
  if (status !== undefined && status >= 500) return "error.server";
  if (info.kind === "stream") return "error.stream";
  return "error.generic";
}
