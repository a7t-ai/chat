import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { memoryChunks, messages } from "../db/schema.ts";
import { embedder } from "../embed/client.ts";

// Tier 3 memory: semantic recall. Embeddings are stored as Float32 blobs in
// memory_chunks; similarity search is a brute-force cosine in JS, which is ample at
// personal scale (thousands of chunks). The schema is sqlite-vec-ready, so an ANN
// index can replace the scan later without a data migration.

const EMBED_MODEL = "bge-m3";

function toBlob(v: number[]): Buffer {
  return Buffer.from(new Float32Array(v).buffer);
}
function fromBlob(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b); // fresh, 4-byte aligned buffer
  return new Float32Array(copy.buffer);
}
function cosine(a: number[], b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < b.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// WRITE: embed any of the conversation's messages not yet embedded.
export async function embedConversation(userId: string, conversationId: string): Promise<void> {
  const msgs = db.select().from(messages).where(eq(messages.conversationId, conversationId)).all();
  const done = new Set(
    db.select({ mid: memoryChunks.messageId }).from(memoryChunks).where(eq(memoryChunks.userId, userId)).all().map((r) => r.mid),
  );
  for (const m of msgs) {
    if (m.role === "system" || done.has(m.id)) continue;
    const content = m.content.trim();
    if (!content) continue;
    let v: number[];
    try {
      v = await embedder.embed(content);
    } catch {
      return; // embed service down — best-effort, try again next turn
    }
    db.insert(memoryChunks).values({
      userId,
      messageId: m.id,
      content,
      embedding: toBlob(v),
      embeddingModel: EMBED_MODEL,
      embeddedAt: new Date(),
    }).run();
  }
}

// READ: the top-K most relevant chunks from the user's OTHER conversations
// (cross-conversation recall; the current conversation is already in context).
export async function recall(
  userId: string,
  query: string,
  excludeConversationId: string | null,
  k = 4,
  minScore = 0.4,
): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];
  let qv: number[];
  try {
    qv = await embedder.embed(q);
  } catch {
    return [];
  }
  const rows = db
    .select({
      content: memoryChunks.content,
      embedding: memoryChunks.embedding,
      conversationId: messages.conversationId,
    })
    .from(memoryChunks)
    .leftJoin(messages, eq(memoryChunks.messageId, messages.id))
    .where(eq(memoryChunks.userId, userId))
    .all();

  return rows
    .filter((r) => r.embedding && r.conversationId !== excludeConversationId)
    .map((r) => ({ content: r.content, score: cosine(qv, fromBlob(r.embedding as Uint8Array)) }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.content);
}
