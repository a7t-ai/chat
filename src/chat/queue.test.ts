import { expect, test } from "bun:test";
import { acquireGenerationSlot, queueDepth } from "./queue.ts";

// Concurrency: with QUEUE_CONCURRENCY=1 (default), generations serialize — the second
// caller waits at position #1 until the first releases, then runs (position 0).
test("serializes generations and reports queue position", async () => {
  const posA: number[] = [];
  const posB: number[] = [];

  const releaseA = await acquireGenerationSlot((n) => posA.push(n));
  expect(posA).toEqual([0]); // A runs immediately
  expect(queueDepth()).toBe(0);

  // B requested while A holds the slot → queued at #1 (set synchronously).
  const bPromise = acquireGenerationSlot((n) => posB.push(n));
  expect(posB).toEqual([1]);
  expect(queueDepth()).toBe(1);

  releaseA(); // free the slot → B is granted (position 0)
  const releaseB = await bPromise;
  expect(posB).toEqual([1, 0]);
  expect(queueDepth()).toBe(0);

  releaseB();
});
