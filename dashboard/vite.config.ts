// The dashboard's build: static files in dist/, served by the listener (listener/static.mjs).
// `npm run dev` proxies the API to a listener on localhost:8080 (LISTENER to change it).
import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

const listener = process.env.LISTENER ?? "http://localhost:8080";

export default defineConfig({
  plugins: [preact()],
  // Relative asset URLs: the page works under any path a reverse proxy gives it.
  base: "./",
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": listener, "/auth": listener } },
  test: {
    environment: "jsdom",
    include: ["src/**/*.spec.{ts,tsx}"],
    setupFiles: ["src/vitest.setup.ts"],
    // Read as it is by tokens.spec.ts (`?raw`): Vitest leaves other CSS out.
    css: { include: [/global\.css/] },
  },
});
