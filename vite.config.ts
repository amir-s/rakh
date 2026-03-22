import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/// <reference types="vitest/config" />

export default defineConfig({
  plugins: [react()],
  test: {
    setupFiles: ["vitest.setup.ts"],
  },
  // Keep class/function names in production bundles.
  // @openrouter/sdk relies on constructor.name ("EventStream") to detect SSE streams.
  esbuild: {
    keepNames: true,
  },
  base: "./",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
  },
});
