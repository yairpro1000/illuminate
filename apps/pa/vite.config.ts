import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const env = loadEnv(mode, repoRoot, "");
  const apiBase = env.VITE_API_BASE || process.env.VITE_API_BASE || "http://127.0.0.1:8788";

  return {
    root: __dirname,
    plugins: [react()],
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "src/shared"),
      },
    },
    server: {
      proxy: {
        "/api": {
          target: apiBase,
          changeOrigin: true,
        },
      },
      fs: {
        allow: [repoRoot],
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
