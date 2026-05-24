import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: ".",
  resolve: {
    alias: {
      "@frontend/react": path.resolve(__dirname, "src"),
      "@frontend/core": path.resolve(__dirname, "../core/src"),
      "@frontend/composer": path.resolve(__dirname, "../composer/src"),
      "@shared/composer": path.resolve(__dirname, "../../../shared/packages/composer/src"),
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: path.resolve(__dirname, "index.html"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:4000",
      "/sse": "http://localhost:4000",
    },
  },
});
