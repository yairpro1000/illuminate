import { describe, expect, it } from "vitest";
import { resolvePaApiBase } from "./runtime";

describe("resolvePaApiBase", () => {
  it("uses the explicit env base when provided", () => {
    expect(resolvePaApiBase({
      hostname: "yairpa.pages.dev",
      envBase: "https://custom.example.com/api/",
      previewEnvBase: "",
    })).toBe("https://custom.example.com/api");
  });

  it("uses workers.dev for pages.dev previews by default", () => {
    expect(resolvePaApiBase({
      hostname: "yairpa.pages.dev",
      envBase: "",
      previewEnvBase: "",
    })).toBe("https://pa-api.yairpro.workers.dev/api");
  });

  it("uses the preview override for pages.dev when configured", () => {
    expect(resolvePaApiBase({
      hostname: "yairpa.pages.dev",
      envBase: "",
      previewEnvBase: "https://preview.example.com/api/",
    })).toBe("https://preview.example.com/api");
  });

  it("keeps same-origin api paths for production hosts", () => {
    expect(resolvePaApiBase({
      hostname: "pa.letsilluminate.co",
      envBase: "",
      previewEnvBase: "",
    })).toBe("/api");
  });
});
