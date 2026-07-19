import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Web unit + component tests. Mirrors IGNIO's bar: v8 coverage, `all: true` so EVERY
// source file counts (untested = 0%), thresholds lines/functions/statements 80, branches
// 70. Pragmatic exclusions: the entrypoint, type-only files, generated/vendored.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      all: true,
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/__tests__/**",
        "src/main.tsx", // entrypoint
        "src/**/*.d.ts",
        "src/vite-env.d.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 70, statements: 80 },
    },
  },
});
