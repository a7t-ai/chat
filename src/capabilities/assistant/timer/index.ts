import type { Capability } from "../../types.ts";

// Recipes / timers — capability #2, the flagship showcase (#10). It's deliberately THIN: it
// ships NO backend routes and NO storage. The whole feature rides primitives that already
// exist —
//   - the shopping list is a plain GFM task list, so it's already tick-able AND live-syncing on
//     the no-login share page (the persistent-TODO primitive, #45);
//   - sharing/live-watch is the shareable-live-collab primitive (shares.ts + share/routes.ts);
//   - the ONE net-new piece is an inline cooking timer, an  [[timer:DURATION|LABEL]]  marker the
//     model drops on timed steps that the client renders as a self-contained countdown chip
//     (and which renders read-only on the public watch page too, since it needs no server).
// So the server half of the capability is purely a system-prompt fragment: it teaches the model
// to format recipes as a checkable shopping list + timed steps. No routes, so `server.ts`'s
// capability loop simply skips the mount — a route-less capability is a first-class shape.

// Taught to the model via the chat system prompt. Turns "give me a recipe" into the flagship
// artifact: a shopping list you (and a partner on the shared link) can tick off, plus steps whose
// waits carry a one-tap timer. Conservative outside cooking so ordinary chat never sprouts timers.
function systemPrompt(): string {
  return [
    "",
    "Recipes: when the user asks for a recipe, a dish, or how to cook/bake something, format the reply so it doubles as a live, shareable cooking companion:",
    "  1. A one-line intro (what it is, rough yield/time).",
    "  2. A '## Shopping list' section written as a GFM task list — one '- [ ] <quantity> <ingredient>' line per ingredient — so it works as a checkable shopping list a partner can tick off on the shared page.",
    "  3. A '## Steps' numbered list. For any step that involves a real wait or cook time, put an inline timer marker right where that timing is mentioned:",
    "       [[timer:DURATION|LABEL]]",
    "     DURATION is a short duration like  20m ,  1h30m ,  90s ,  1h  (units: h/m/s; you may also write mm:ss like  1:30 ). LABEL is a 1–4 word action, e.g. 'Simmer' or 'Bake'. The marker renders as a small 'start timer' button, so don't describe the button itself — write the step naturally, e.g. 'Simmer the sauce [[timer:20m|Simmer]] until thickened.'",
    "Example step: 'Bake until golden [[timer:25m|Bake]], then rest [[timer:10m|Rest]] before slicing.'",
    "Rules: only add a timer to a genuinely timed step — don't put one on every step or in ordinary chat. One clean duration plus a short label per marker; never put ']' or '|' inside the label, and put nothing else in the marker. Outside recipes, only emit a timer when the user explicitly asks to time or remind them of something.",
  ].join("\n");
}

export const timer: Capability = {
  id: "timer",
  title: "Recipes & timers",
  pillar: "assistant",
  enabled: true,
  systemPrompt,
  // Contextual nudge (#22): when the user is circling food/cooking but the reply didn't already
  // turn into the flagship recipe artifact (a checkable shopping list + step timers), point them
  // at it. Suppressed automatically once the reply carries a `[[timer:` marker (i.e. it already
  // rendered a proper recipe), so it only fires for "what should I cook"-style adjacent intents.
  suggestion: {
    title: "Cook along with timers",
    body: "Ask for a recipe and I'll build a shareable shopping list with one-tap step timers.",
    triggers: [
      "recipe",
      "what should i cook",
      "what to cook",
      "what to make for dinner",
      "how to bake",
      "how to cook",
      "meal prep",
      "dinner idea",
      "dinner ideas",
    ],
  },
};
