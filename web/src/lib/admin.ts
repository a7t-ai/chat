// Admin telemetry helpers. The guest-key/Bearer credential path was retired (invites now carry
// the per-account guardrails), so the /api/admin/keys client helpers are gone — only the stats
// surface remains here.
import { authHeaders } from "./api";

export interface JanoHealth {
  currentModel?: string;
  queueDepth?: number;
  inFlight?: number;
  swapsLast15m?: number;
  swapsLastHour?: number;
  recentGenTokS?: number;
  uptimeSeconds?: number;
  requestsServedTotal?: number;
  tokensGeneratedTotal?: number;
  errorsLast15m?: number;
  backendHealth?: Record<string, string>;
}

export interface Stats {
  totals: {
    users: number;
    conversations: number;
    messages: number;
    activeKeys: number;
    requests: number;
    tokensIn: number;
    tokensOut: number;
  };
  last24h: { requests: number; tokensIn: number; tokensOut: number };
  byModel: { model: string; requests: number; tokensIn: number; tokensOut: number }[];
  recent: { login: string | null; model: string | null; tokensIn: number; tokensOut: number; at: number }[];
  backend: { models: string[]; jano: JanoHealth | null };
}

export async function fetchStats(): Promise<Stats> {
  const res = await fetch("/api/admin/stats", { headers: authHeaders() });
  if (!res.ok) throw new Error(`/api/admin/stats -> ${res.status}`);
  return res.json() as Promise<Stats>;
}
