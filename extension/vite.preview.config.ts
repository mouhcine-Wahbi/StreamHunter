/**
 * Browser preview: serves the real extension pages on http://localhost:5173 with a
 * chrome.* API shim injected first (src/dev/chrome-shim.ts). For UI work only;
 * the shipped extension is built by vite.config.ts and never includes the shim.
 */
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const injectShim: Plugin = {
  name: "streamhunter-chrome-shim",
  transformIndexHtml: () => [{ tag: "script", attrs: { type: "module", src: "/src/dev/chrome-shim.ts" }, injectTo: "head" }],
};

const redirectRoot: Plugin = {
  name: "streamhunter-root-redirect",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === "/" || req.url === "/index.html") {
        res.statusCode = 302;
        res.setHeader("Location", "/app.html#/overview");
        res.end();
        return;
      }
      next();
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), injectShim, redirectRoot],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  server: { host: "0.0.0.0", port: 5173, strictPort: true },
});
