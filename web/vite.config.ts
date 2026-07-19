import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: Vite on 5173 proxies the API to the Bun backend on 8787.
// Build: emits to web/dist, which the Bun server serves in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/health": "http://127.0.0.1:8787",
    },
  },
  build: { outDir: "dist" },
});
