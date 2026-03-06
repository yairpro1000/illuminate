import { z } from "zod";
import { SPEECH_LANG_OPTIONS } from "./speech";

export const TRANSLATE_LIST_ID = "translate";

export const TRANSLATE_LANG_VALUES = SPEECH_LANG_OPTIONS.filter((o) => o.value !== "auto").map((o) => o.value) as ReadonlyArray<
  "en-US" | "he-IL" | "es-ES" | "fr-FR" | "de-DE" | "it-IT"
>;

export type TranslateLang = (typeof TRANSLATE_LANG_VALUES)[number];

export function translateLangLabel(lang: TranslateLang | ""): string {
  if (!lang) return "—";
  return SPEECH_LANG_OPTIONS.find((o) => o.value === lang)?.label ?? lang;
}

export function translateLangFlag(lang: TranslateLang | ""): string {
  switch (lang) {
    case "en-US":
      return "🇺🇸";
    case "he-IL":
      return "🇮🇱";
    case "es-ES":
      return "🇪🇸";
    case "fr-FR":
      return "🇫🇷";
    case "de-DE":
      return "🇩🇪";
    case "it-IT":
      return "🇮🇹";
    default:
      return "🏳️";
  }
}

function normalizeSpaces(s: string) {
  return String(s ?? "").replaceAll(/\s+/g, " ").trim();
}

export function isTranslateLike(raw: string): boolean {
  const s = normalizeSpaces(raw).toLowerCase();
  if (!s) return false;

  if (s.startsWith("translate ")) return true;
  if (s === "translate") return true;

  // English
  if (/^how do you say\b/.test(s)) return true;
  if (/^how to say\b/.test(s)) return true;

  // Italian (typo-tolerant for "se/si")
  if (/^come s[ie] dice\b/.test(s)) return true;

  // Spanish
  if (/^como se dice\b/.test(s)) return true;

  return false;
}

export const TranslationPayloadZ = z
  .object({
    originLanguage: z.enum(["en-US", "he-IL", "es-ES", "fr-FR", "de-DE", "it-IT"]).or(z.literal("")),
    originExpression: z.string(),
    destinationLanguage: z.enum(["en-US", "he-IL", "es-ES", "fr-FR", "de-DE", "it-IT"]).or(z.literal("")),
    possibleTranslations: z.array(z.string()),
    examplesOrigin: z.array(z.string()),
    examplesDestination: z.array(z.string()),
    comments: z.string(),
  })
  .strict();

export type TranslationPayload = z.infer<typeof TranslationPayloadZ>;

