import { z } from "zod";
import { instrumentFetch, type ObservabilityLogger } from "../../../shared/observability/backend.js";

export const TranslateLangZ = z.enum(["en-US", "he-IL", "es-ES", "fr-FR", "de-DE", "it-IT"]);
export type TranslateLang = z.infer<typeof TranslateLangZ>;

export const TranslationPayloadZ = z
  .object({
    originLanguage: TranslateLangZ.or(z.literal("")),
    originExpression: z.string(),
    destinationLanguage: TranslateLangZ.or(z.literal("")),
    possibleTranslations: z.array(z.string()),
    examplesOrigin: z.array(z.string()),
    examplesDestination: z.array(z.string()),
    comments: z.string(),
  })
  .strict();
export type TranslationPayload = z.infer<typeof TranslationPayloadZ>;

export const TranslateResponseZ = z
  .object({
    translation: TranslationPayloadZ,
  })
  .strict();

export const TranslateRefineResponseZ = z
  .object({
    translation: TranslationPayloadZ,
    answer: z.string(),
  })
  .strict();

function textPreview(s: string, max = 220) {
  const t = String(s ?? "");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

async function openAiChatCompletionsJson(
  apiKey: string,
  payload: Record<string, unknown> & { model: string },
  logger?: ObservabilityLogger,
  operation = "chat_completions",
) {
  const body = JSON.stringify(payload);
  const res = logger
    ? await instrumentFetch(logger, {
        provider: "openai",
        operation,
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      })
    : await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body,
      });
  if (res.ok) return res;
  const bodyText = await res.text();
  throw new Error(`OpenAI error: ${res.status} ${bodyText}`);
}

async function openAiChatCompletionsJsonBestEffort(
  apiKey: string,
  payload: Record<string, unknown> & { model: string },
  logger?: ObservabilityLogger,
  operation?: string,
) {
  try {
    return await openAiChatCompletionsJson(apiKey, payload, logger, operation);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    const seemsLikeResponseFormatIssue =
      /response_format/i.test(msg) ||
      /json_schema/i.test(msg) ||
      /Unknown parameter/i.test(msg) ||
      /Unrecognized request argument/i.test(msg);
    if (!seemsLikeResponseFormatIssue) throw e;

    const cloned = { ...payload } as any;
    delete cloned.response_format;
    return await openAiChatCompletionsJson(apiKey, cloned, logger, operation);
  }
}

function translateSystemPrompt(allowed: TranslateLang[]) {
  const langs = allowed
    .map((l) => {
      switch (l) {
        case "en-US":
          return `${l} (English)`;
        case "he-IL":
          return `${l} (Hebrew)`;
        case "es-ES":
          return `${l} (Spanish)`;
        case "fr-FR":
          return `${l} (French)`;
        case "de-DE":
          return `${l} (German)`;
        case "it-IT":
          return `${l} (Italian)`;
        default:
          return l;
      }
    })
    .join(", ");

  return [
    "You are a translation assistant.",
    "Return ONLY valid JSON (no markdown, no prose, no code fences).",
    "The JSON must be a single object.",
    "",
    "You will receive a user's request like:",
    '- "how do you say chicken in italian"',
    '- "translate aggiungere"',
    '- "translate idempotency to hebrew"',
    '- "come se dice il latte in francese"',
    "",
    "You MUST output JSON in this exact shape:",
    "{",
    '  "translation": {',
    '    "originLanguage": "it-IT" | "en-US" | "he-IL" | "es-ES" | "fr-FR" | "de-DE" | "",',
    '    "originExpression": "string",',
    '    "destinationLanguage": "it-IT" | "en-US" | "he-IL" | "es-ES" | "fr-FR" | "de-DE" | "",',
    '    "possibleTranslations": ["string", "..."],',
    '    "examplesOrigin": ["string", "..."],',
    '    "examplesDestination": ["string", "..."],',
    '    "comments": "string"',
    "  }",
    "}",
    "",
    `Allowed languages (BCP-47 codes) for origin/destination: ${langs}.`,
    "If the user requests a language outside the allowed list, set originLanguage/destinationLanguage to \"\" and explain in comments; keep arrays empty.",
    "",
    "Guidelines:",
    "- Detect originLanguage if possible; if unclear, leave it as \"\" and explain in comments.",
    "- Detect destinationLanguage from the request; if missing, choose the most likely and explain briefly in comments.",
    "- possibleTranslations should be short, natural alternatives (2–6 items).",
    "- examplesOrigin and examplesDestination should align 1:1 when possible (2–4 items).",
    "- Keep comments concise: register, nuance, literal vs idiomatic, or grammar notes.",
  ].join("\n");
}

function refineSystemPrompt(allowed: TranslateLang[]) {
  return [
    "You are a translation assistant helping refine a translation entry.",
    "Return ONLY valid JSON (no markdown, no prose, no code fences).",
    "The JSON must be a single object.",
    "",
    "You will receive:",
    "- a current draft translation object (comments field is omitted — it is managed client-side)",
    "- existingComments: the accumulated comments so far, provided for context only",
    "- an optional user question",
    "",
    "You MUST output JSON in this exact shape:",
    "{",
    '  "translation": {',
    '    "originLanguage": "it-IT" | "en-US" | "he-IL" | "es-ES" | "fr-FR" | "de-DE" | "",',
    '    "originExpression": "string",',
    '    "destinationLanguage": "it-IT" | "en-US" | "he-IL" | "es-ES" | "fr-FR" | "de-DE" | "",',
    '    "possibleTranslations": ["string", "..."],',
    '    "examplesOrigin": ["string", "..."],',
    '    "examplesDestination": ["string", "..."],',
    '    "comments": "string"',
    "  },",
    '  "answer": "string"',
    "}",
    "",
    `Allowed languages (BCP-47 codes) for origin/destination: ${allowed.join(", ")}.`,
    "If asked for an unsupported language, explain in answer and comments, and keep languages \"\".",
    "The 'answer' must directly answer the user's question (or be \"\" if no question).",
    "translation.comments must contain ONLY new notes from this response — do NOT copy or repeat existingComments.",
    "Leave translation.comments as \"\" if you have nothing new to add.",
    "Prefer updating the translation fields only when the question or draft implies a change.",
  ].join("\n");
}

function extractAssistantContent(json: any): string {
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("OpenAI response missing content.");
  return text;
}

export async function translateWithOpenAI(opts: {
  apiKey: string;
  model: string;
  input: string;
  allowedLanguages: TranslateLang[];
  requestId?: string;
  logger?: ObservabilityLogger;
}): Promise<TranslationPayload> {
  const system = translateSystemPrompt(opts.allowedLanguages);
  const user = JSON.stringify({ request: opts.input });

  const res = await openAiChatCompletionsJsonBestEffort(opts.apiKey, {
    model: opts.model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  }, opts.logger, "translate");
  const json = (await res.json()) as any;
  const text = extractAssistantContent(json);

  const raw = JSON.parse(text);
  const parsed = TranslateResponseZ.parse(raw);
  return parsed.translation;
}

export async function refineTranslationWithOpenAI(opts: {
  apiKey: string;
  model: string;
  draft: TranslationPayload;
  question?: string;
  allowedLanguages: TranslateLang[];
  requestId?: string;
  logger?: ObservabilityLogger;
}): Promise<{ translation: TranslationPayload; answer: string }> {
  const system = refineSystemPrompt(opts.allowedLanguages);
  // Strip comments from the draft so the LLM doesn't echo them back into translation.comments.
  // Pass them separately as existingComments for context only.
  const { comments: existingComments, ...draftWithoutComments } = opts.draft;
  const user = JSON.stringify({ draft: draftWithoutComments, existingComments, question: opts.question ?? "" });

  const res = await openAiChatCompletionsJsonBestEffort(opts.apiKey, {
    model: opts.model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  }, opts.logger, "translate_refine");
  const json = (await res.json()) as any;
  const text = extractAssistantContent(json);

  const raw = JSON.parse(text);
  const parsed = TranslateRefineResponseZ.parse(raw);
  return { translation: parsed.translation, answer: parsed.answer };
}
