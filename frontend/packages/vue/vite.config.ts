import path from "node:path";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vue()],
  root: ".",
  resolve: {
    alias: {
      "@frontend/vue": path.resolve(__dirname, "src"),
      "@frontend/core": path.resolve(__dirname, "../core/src"),
      "@frontend/composer": path.resolve(__dirname, "../composer/src"),
      "@shared/composer": path.resolve(__dirname, "../../../shared/packages/composer/src"),
      "el-lowcode": path.resolve(__dirname, "../bastard/packages/el-lowcode"),
      "@el-lowcode/utils": path.resolve(__dirname, "../bastard/packages/utils"),
      "@el-lowcode/render": path.resolve(__dirname, "../bastard/packages/render"),
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
      },
    },
  },
  server: {
    fs: {
      allow: [path.resolve(__dirname, "..")],
    },
    proxy: {
      "/api": "http://localhost:4000",
      "/sse": "http://localhost:4000",
    },
  },
});
