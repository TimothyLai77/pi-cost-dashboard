import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  server: {
    port: 5173,
    // The dev server keeps its own origin; API calls are proxied to the Express server
    // so the dashboard code can use relative /api paths in dev and in production alike.
    proxy: {
      "/api": {
        target: process.env.PI_COST_PROXY_TARGET ?? "http://127.0.0.1:4870",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
