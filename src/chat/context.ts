import { config } from "../config.ts";
import { conversationSummary } from "../memory/service.ts";
import { catalogEntry } from "../models/catalog.ts";
import {
  type ContextUsage,
  contextUsage,
  estimateTokens,
  estimateTurnsTokens,
  resolveContextWindow,
} from "./compaction.ts";
import { compactionStartIndex, type ThreadSlot } from "./service.ts";

// The EFFECTIVE context-window usage for a conversation (#38) — what the NEXT model prompt actually
// carries, metered against the ACTIVE model's window:
//   - the turns AFTER the compaction boundary, verbatim (the folded ones are dropped from the prompt)
//   - plus the rolling summary that stands in for the folded turns
// So compacting visibly DROPS the meter (fewer verbatim turns), mirroring how the real prompt shrinks
// — the transcript itself is untouched. The window comes from the live catalog's contextTokens (#63)
// with a conservative fail-safe for an unknown model. The arithmetic is the tested pure core
// (src/chat/compaction.ts); this only wires the conversation's slots + summary + model into it.
//
// `ownerId` is the conversation OWNER — the summary always follows the owner (the memory seam), so a
// collaborator sees the same, owner-scoped context reading. Slots are passed in (the caller already
// built the thread) to avoid a second query.
export function conversationContextUsage(params: {
  slots: ThreadSlot[];
  ownerId: string;
  conversationId: string;
  model: string | null;
  compactedThroughMessageId: string | null;
}): ContextUsage {
  const { slots, ownerId, conversationId, model, compactedThroughMessageId } = params;
  const modelId = model ?? config.defaultModel;
  const window = resolveContextWindow(modelId, catalogEntry(modelId)?.contextTokens);
  const start = compactionStartIndex(slots, compactedThroughMessageId);
  const effectiveTurns = slots.slice(start).map((s) => ({ content: s.active.content }));
  const summary = conversationSummary(ownerId, conversationId) ?? "";
  const used = estimateTurnsTokens(effectiveTurns) + estimateTokens(summary);
  return contextUsage(used, window);
}
