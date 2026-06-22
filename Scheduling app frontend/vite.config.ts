import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy /api to the backend. Defaults to localhost for local dev; override with
// VITE_PROXY_TARGET (e.g. http://backend:4100) when running in Docker Compose.
const proxyTarget = process.env.VITE_PROXY_TARGET || "http://localhost:4100";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": proxyTarget,
    },
  },
});
