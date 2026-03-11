import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const DEFAULT_LOCAL_API_TARGET = "http://127.0.0.1:8788";

function resolveDevProxyTarget(raw: string | undefined): string {
  const value = String(raw ?? "").trim();
  if (!value) return DEFAULT_LOCAL_API_TARGET;

  // Vite proxy target must be an absolute URL. Values like "/api" are invalid here.
  if (value.startsWith("/")) return DEFAULT_LOCAL_API_TARGET;

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
  } catch {
    // Continue to relaxed host:port fallback.
  }

  // Allow host:port without protocol, e.g. "127.0.0.1:8788".
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.hostname) return parsed.origin;
  } catch {
    // Ignore and fallback.
  }

  return DEFAULT_LOCAL_API_TARGET;
}

export default defineConfig(({ mode }) => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const env = loadEnv(mode, repoRoot, "");
  const apiBase = resolveDevProxyTarget(env.VITE_API_BASE || process.env.VITE_API_BASE);

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
