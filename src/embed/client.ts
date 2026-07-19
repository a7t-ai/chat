import { config } from "../config.ts";

// Client for the embedding service (the existing the workstation-stead llama-server --embedding,
// BGE-M3, on :8083). Off Jano. Behind an interface so it stays swappable.
export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export class LlamaEmbedder implements Embedder {
  constructor(private readonly baseUrl: string = config.embedUrl) {}

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: text }),
    });
    if (!res.ok) throw new Error(`embed -> ${res.status}`);
    const data = (await res.json()) as { data?: { embedding?: number[] }[] };
    const v = data.data?.[0]?.embedding;
    if (!v || v.length === 0) throw new Error("embed: empty embedding");
    return v;
  }
}

export const embedder: Embedder = new LlamaEmbedder();
