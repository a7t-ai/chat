import { vi } from "vitest";

// Node 25 ships an experimental built-in Web Storage that shadows jsdom's `localStorage`
// in this env with a method-less stub (no setItem/getItem/clear). The app uses bare
// `localStorage.*` everywhere, so tests install a real in-memory Storage to exercise it.
// Call `installLocalStorage()` from a test's `beforeEach`. Excluded from coverage
// (src/__tests__/** is excluded in vitest.config.ts).
export function installLocalStorage(): Storage {
  const store = new Map<string, string>();
  const ls: Storage = {
    get length() {
      return store.size;
    },
    clear: () => {
      store.clear();
    },
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
  };
  vi.stubGlobal("localStorage", ls);
  return ls;
}
