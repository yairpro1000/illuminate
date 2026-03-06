export function getSpeechRecognition(): SpeechRecognitionCtor | null {
  return (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).SpeechRecognition ||
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).webkitSpeechRecognition ||
    null
  );
}

export const SPEECH_LANG_STORAGE_KEY = "pa.speech.lang";

export const SPEECH_LANG_OPTIONS = [
  { value: "auto", label: "Auto (browser)" },
  { value: "en-US", label: "English (US)" },
  { value: "he-IL", label: "Hebrew (Israel)" },
  { value: "es-ES", label: "Spanish (Spain)" },
  { value: "fr-FR", label: "French (France)" },
  { value: "de-DE", label: "German (Germany)" },
  { value: "it-IT", label: "Italian (Italy)" },
] as const;

export type SpeechLangValue = (typeof SPEECH_LANG_OPTIONS)[number]["value"];
export const DEFAULT_SPEECH_LANG_VALUE: SpeechLangValue = "auto";

const SUPPORTED_SPEECH_LANGS = SPEECH_LANG_OPTIONS.filter((o) => o.value !== "auto").map((o) => o.value);

function bestBrowserLangMatch(): string | null {
  if (typeof navigator === "undefined") return null;
  const prefs = Array.isArray(navigator.languages) && navigator.languages.length ? navigator.languages : [navigator.language];
  for (const raw of prefs) {
    const lang = String(raw || "").trim();
    if (!lang) continue;
    if (SUPPORTED_SPEECH_LANGS.includes(lang)) return lang;
    const base = lang.split("-")[0];
    const baseMatch = SUPPORTED_SPEECH_LANGS.find((v) => v.split("-")[0] === base);
    if (baseMatch) return baseMatch;
  }
  return null;
}

export function resolveSpeechLang(value: string): string {
  if (value === "auto") return bestBrowserLangMatch() ?? "en-US";
  if (SUPPORTED_SPEECH_LANGS.includes(value)) return value;
  return bestBrowserLangMatch() ?? "en-US";
}

export type SpeechRecognitionLike = SpeechRecognition & {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
};

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
