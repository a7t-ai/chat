import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { installLocalStorage } from "./localStorage";

// Node 25 ships an experimental built-in Web Storage that shadows jsdom's `localStorage`
// with a method-less stub (no setItem/getItem/clear), which breaks modules that read
// localStorage at import time (e.g. lib/i18n). Install a real in-memory Storage here, in
// setupFiles, so it's present BEFORE any test module is imported. Per-test resets call
// installLocalStorage() again from their own beforeEach.
installLocalStorage();

// Unmount React trees between tests so component tests don't leak DOM into each other.
afterEach(() => cleanup());
