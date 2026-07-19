import { Hono } from "hono";
import { forgetAllMemory, forgetFact, listFacts, memoryEnabledFor } from "./service.ts";

// Archivist memory management (#27). Mounted at /api/memory, already behind the auth gate. This
// is the transparency + control surface for durable memory: SEE what a7t.chat remembers about you,
// FORGET any one fact, or FORGET everything. It's the caller's OWN account data (like /api/settings),
// so it's authed but intentionally NOT entitlement-gated — memory is a core, free pillar, never a
// paywall. Every operation is scoped to auth.user.id server-side; no route names another user, so
// cross-account read or delete is impossible. The on/off switch itself rides preferences
// (memory.enabled via PUT /api/settings), so it syncs across the user's instances like every other
// preference — this route only reports its state.
const memoryApp = new Hono();

// What we durably remember about the caller + whether memory is currently on. Facts are the
// human-readable derived tier (createdAt lets the UI show when each was learned).
memoryApp.get("/", (c) => {
  const auth = c.get("auth");
  return c.json({ enabled: memoryEnabledFor(auth.user.id), facts: listFacts(auth.user.id) });
});

// Forget everything a7t.chat has learned (facts + summaries + embeddings), scoped to the caller.
// Placed before "/:id" so the collection DELETE never falls into the item route. Idempotent: with
// nothing stored it clears 0 and still succeeds.
memoryApp.delete("/", (c) => {
  const auth = c.get("auth");
  return c.json({ ok: true, cleared: forgetAllMemory(auth.user.id) });
});

// Forget one remembered fact. Scoped to the caller (unknown / another account's id → 404, no
// existence oracle — mirrors the files manager).
memoryApp.delete("/:id", (c) => {
  const auth = c.get("auth");
  return forgetFact(auth.user.id, c.req.param("id"))
    ? c.json({ ok: true })
    : c.json({ error: "not found" }, 404);
});

export default memoryApp;
