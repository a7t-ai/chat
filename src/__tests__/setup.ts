// Backend test preload (bunfig `[test] preload`). Point the DB at a throwaway file so
// tests never touch the real chat.db. Set before any module imports db/index.ts.
process.env.DB_PATH = `/tmp/a7t-chat-test-${process.pid}.db`;
// Point the attachments store (#15) at a throwaway dir so tests never touch the real files dir.
process.env.FILES_DIR = `/tmp/a7t-chat-test-files-${process.pid}`;
// A fixed, valid 32-byte hex BYOK key so byok/crypto is available under test (never a real key —
// this only exercises the local encrypt/decrypt round-trip against the temp DB).
process.env.BYOK_ENCRYPTION_KEY =
  process.env.BYOK_ENCRYPTION_KEY ?? "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
// Pin the web-search provider to SearXNG under test so selectProvider() resolves deterministically
// on a clean clone / CI (no .env). The URL is never contacted — the provider tests stub fetch.
process.env.WEB_SEARCH_PROVIDER = process.env.WEB_SEARCH_PROVIDER ?? "searxng";
process.env.SEARXNG_URL = process.env.SEARXNG_URL ?? "http://127.0.0.1:8888";
