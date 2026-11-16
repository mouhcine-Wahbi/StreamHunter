/// <reference types="vitest/config" />
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const root = __dirname;

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(root, "src") } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: mode === "development",
    assetsInlineLimit: 0,
    // Extension pages load from disk; the preload polyfill is unnecessary and would
    // also be injected into the service worker bundle.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        popup: resolve(root, "popup.html"),
        app: resolve(root, "app.html"),
        sidepanel: resolve(root, "sidepanel.html"),
        offscreen: resolve(root, "offscreen.html"),
        "service-worker": resolve(root, "src/background/service-worker.ts"),
      },
      output: {
        // manifest.json references the worker by a fixed file name.
        entryFileNames: (chunk) =>
          chunk.name === "service-worker" ? "service-worker.js" : "assets/[name]-[hash].js",
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test/setup.ts"],
    css: false,
    restoreMocks: true,
  },
}));
