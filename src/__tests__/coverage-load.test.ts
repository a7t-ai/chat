import { Glob } from "bun";
import { expect, test } from "bun:test";

// Bun only measures coverage for files the run actually LOADS, so untested modules would
// silently not drag coverage down. This imports every backend module (except entrypoints
// with side effects) so `bun test --coverage` reflects the WHOLE backend — and doubles as
// a smoke test that nothing throws on import. The loop raises real coverage from here.
const EXCLUDE = new Set(["src/server.ts", "src/db/migrate.ts"]);

test("every backend module imports cleanly (honest coverage denominator)", async () => {
  const glob = new Glob("src/**/*.ts");
  let count = 0;
  for await (const path of glob.scan({ cwd: process.cwd() })) {
    if (path.endsWith(".test.ts") || path.includes("/migrations/") || path.includes("/__tests__/") || EXCLUDE.has(path)) {
      continue;
    }
    await import(`${process.cwd()}/${path}`);
    count++;
  }
  expect(count).toBeGreaterThan(10);
});
