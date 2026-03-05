import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const env = loadEnv(mode, repoRoot, "");
  const apiPort = env.PA_API_PORT || process.env.PA_API_PORT || "8787";

  return {
    root: __dirname,
    plugins: [react()],
    resolve: {
      alias: {
        "@shared": path.resolve(repoRoot, "pa-v1/shared"),
      },
    },
    server: {
      proxy: {
        "/pa": {
          target: `http://127.0.0.1:${apiPort}`,
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

