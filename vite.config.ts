import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    // API_PORT: where `npm run dev:server` listens when PORT is not 8080.
    proxy: { "/api": `http://localhost:${process.env.API_PORT ?? 8080}` },
  },
});
