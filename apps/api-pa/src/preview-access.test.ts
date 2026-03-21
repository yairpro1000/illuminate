import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./index";

type CapturedLog = { level: "log" | "warn" | "error"; payload: any };

function captureConsole() {
  const entries: CapturedLog[] = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  function wrap(level: CapturedLog["level"]) {
    return (...args: unknown[]) => {
      const jsonArg = args.find((value) => typeof value === "string" && value.startsWith("{"));
      if (typeof jsonArg === "string") {
        entries.push({ level, payload: JSON.parse(jsonArg) });
      }
    };
  }

  console.log = wrap("log");
  console.warn = wrap("warn");
  console.error = wrap("error");

  return {
    entries,
    restore() {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

function makeEnv() {
  return {
    API_ALLOWED_ORIGINS: "https://yairpa.pages.dev",
    PA_PREVIEW_DEV_EMAIL: "yairpro@gmail.com",
  } as any;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("preview access", () => {
  it("allows pages.dev preview traffic to workers.dev with preview dev auth and CORS", async () => {
    const captured = captureConsole();
    try {
      const response = await app.request(
        "https://pa-api.yairpro.workers.dev/api/me",
        {
          headers: {
            origin: "https://yairpa.pages.dev",
          },
        },
        makeEnv(),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("https://yairpa.pages.dev");
      await expect(response.json()).resolves.toEqual({ user: { email: "yairpro@gmail.com" } });
    } finally {
      captured.restore();
    }
  });

  it("returns a structured 403 and log when preview preflight origin is denied", async () => {
    const captured = captureConsole();
    try {
      const response = await app.request(
        "https://pa-api.yairpro.workers.dev/api/me",
        {
          method: "OPTIONS",
          headers: {
            origin: "https://evil.pages.dev",
          },
        },
        makeEnv(),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: "forbidden",
      });

      expect(
        captured.entries.some((entry) =>
          entry.payload?.eventType === "cors_denied" &&
          entry.payload?.context?.cors_deny_reason === "origin_not_allowed"
        ),
      ).toBe(true);
    } finally {
      captured.restore();
    }
  });
});
