import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const projectRoot = path.resolve(__dirname, "..");
  const env = loadEnv(mode, projectRoot, "");
  const port = env.PA_PORT || process.env.PA_PORT || "8787";

  return {
    root: __dirname,
    plugins: [react()],
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "../shared"),
      },
    },
    server: {
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${port}`,
          changeOrigin: true,
        },
      },
      fs: {
        allow: [projectRoot],
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
