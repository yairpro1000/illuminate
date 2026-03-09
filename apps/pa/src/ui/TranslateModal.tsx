import React from "react";
import type { TranslationPayload, TranslateLang } from "./translate";
import { TRANSLATE_LANG_VALUES, translateLangFlag, translateLangLabel } from "./translate";
import { API_BASE } from "../api";

const norm = (l: string) => l.replace(/_/g, "-");

function findVoice(voices: SpeechSynthesisVoice[], lang: string): SpeechSynthesisVoice | null {
  return (
    voices.find((v) => norm(v.lang) === norm(lang)) ??
    voices.find((v) => norm(v.lang).startsWith(lang.split("-")[0])) ??
    null
  );
}

async function speakViaApi(text: string, lang: string) {
  try {
    const res = await fetch(`${API_BASE}/speak`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang }),
      credentials: "include",
    });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    audio.play();
  } catch {
    // ignore
  }
}

function speak(text: string, lang: string) {
  const s = String(text ?? "").trim();
  if (!s) return;
  if (typeof window === "undefined") return;

  function doSpeak(voices: SpeechSynthesisVoice[]) {
    const match = lang ? findVoice(voices, lang) : null;
    if (!match) {
      speakViaApi(s, lang);
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(s);
      u.voice = match;
      u.lang = match.lang;
      window.speechSynthesis.speak(u);
    } catch {
      // ignore
    }
  }

  if (!("speechSynthesis" in window)) {
    speakViaApi(s, lang);
    return;
  }

  const voices = window.speechSynthesis.getVoices();
  if (voices.length === 0) {
    window.speechSynthesis.onvoiceschanged = () => {
      window.speechSynthesis.onvoiceschanged = null;
      doSpeak(window.speechSynthesis.getVoices());
    };
  } else {
    doSpeak(voices);
  }
}

function normalizeLines(s: string) {
  return String(s ?? "").replaceAll(/\r\n/g, "\n");
}

function joinComments(a: string, b: string) {
  const aa = normalizeLines(a).trim();
  const bb = normalizeLines(b).trim();
  if (aa && bb) return `${aa}\n\n${bb}`;
  return aa || bb;
}

function appendQa(comments: string, q: string, a: string) {
  const qq = String(q ?? "").trim();
  const aa = String(a ?? "").trim();
  if (!qq && !aa) return comments;
  const lines: string[] = [];
  if (qq) lines.push(`Q: ${qq}`);
  if (aa) lines.push(`A: ${aa}`);
  if (!lines.length) return comments;
  const block = lines.join("\n");
  const base = normalizeLines(comments).trim();
  return base ? `${base}\n\n${block}` : block;
}

function clampArray(values: string[]) {
  return values.map((v) => String(v ?? "").trim()).filter((v) => v.length > 0);
}

export function TranslateModal(props: {
  open: boolean;
  title?: string;
  initial: TranslationPayload;
  onClose: () => void;
  onSave: (next: TranslationPayload) => Promise<void>;
  onDelete: () => Promise<void>;
  onRepeat: (draft: TranslationPayload, question: string) => Promise<{ translation: TranslationPayload; answer: string }>;
}) {
  const [draft, setDraft] = React.useState<TranslationPayload>(props.initial);
  const [question, setQuestion] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!props.open) return;
    setDraft(props.initial);
    setQuestion("");
    setErr(null);
    setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  if (!props.open) return null;

  async function repeat() {
    const q = question.trim();
    setErr(null);
    setBusy(true);
    try {
      const refined = await props.onRepeat(draft, q);
      setDraft((prev) => {
        const mergedComments = joinComments(prev.comments, refined.translation.comments);
        const withQa = q ? appendQa(mergedComments, q, refined.answer) : mergedComments;
        return {
          ...refined.translation,
          possibleTranslations: clampArray(refined.translation.possibleTranslations),
          examplesOrigin: clampArray(refined.translation.examplesOrigin),
          examplesDestination: clampArray(refined.translation.examplesDestination),
          comments: withQa,
        };
      });
      setQuestion("");
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setErr(null);
    setBusy(true);
    try {
      await props.onSave({
        ...draft,
        originExpression: String(draft.originExpression ?? ""),
        possibleTranslations: clampArray(draft.possibleTranslations),
        examplesOrigin: clampArray(draft.examplesOrigin),
        examplesDestination: clampArray(draft.examplesDestination),
      });
      props.onClose();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    const confirmed = window.confirm("Delete this translation item?");
    if (!confirmed) return;
    setErr(null);
    setBusy(true);
    try {
      await props.onDelete();
      props.onClose();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function langSelect(value: TranslateLang | "", onChange: (v: TranslateLang | "") => void, label: string) {
    return (
      <div className="formCol" style={{ minWidth: 120 }}>
        <label className="small muted">{label}</label>
        <select value={value} onChange={(e) => onChange(e.target.value as any)} disabled={busy}>
          <option value="">—</option>
          {TRANSLATE_LANG_VALUES.map((v) => (
            <option key={v} value={v}>
              {translateLangFlag(v)} {translateLangLabel(v)}
            </option>
          ))}
        </select>
      </div>
    );
  }

  function arrayEditor(opts: {
    label: string;
    values: string[];
    onChange: (next: string[]) => void;
    speakLang: string;
    placeholder?: string;
  }) {
    return (
      <div style={{ marginTop: 10 }}>
        <div className="row" style={{ alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <label className="small muted">{opts.label}</label>
          <button
            className="iconbtn"
            onClick={() => opts.onChange([...(opts.values ?? []), ""])}
            disabled={busy}
            title="Add row"
          >
            + Add
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {(opts.values ?? []).length === 0 ? (
            <div className="muted small" style={{ padding: "6px 0" }}>
              —
            </div>
          ) : null}
          {(opts.values ?? []).map((v, i) => (
            <div key={i} className="row" style={{ alignItems: "center", gap: 8 }}>
              <button
                className="iconbtn"
                onClick={() => speak(v, opts.speakLang)}
                disabled={busy || !String(v ?? "").trim()}
                title="Speak"
              >
                🔊
              </button>
              <input
                value={String(v ?? "")}
                placeholder={opts.placeholder}
                onChange={(e) => {
                  const next = [...opts.values];
                  next[i] = e.target.value;
                  opts.onChange(next);
                }}
                disabled={busy}
              />
              <button
                className="iconbtn"
                style={{ color: "var(--danger)", borderColor: "rgba(255,107,107,0.4)" }}
                onClick={() => opts.onChange(opts.values.filter((_, j) => j !== i))}
                disabled={busy}
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="dialogOverlay" onClick={() => (busy ? null : props.onClose())} />
      <dialog open className="dialog">
        <div className="topbar" style={{ marginBottom: 12 }}>
          <div>
            <div className="title">{props.title ?? "Translate"}</div>
            <div className="muted small">Edit • speak • ask follow-ups • save</div>
          </div>
          <div className="btnrow">
            <button onClick={props.onClose} disabled={busy}>
              Close
            </button>
          </div>
        </div>

        <div className="formRow" style={{ alignItems: "flex-end" }}>
          {langSelect(draft.originLanguage as any, (v) => setDraft((p) => ({ ...p, originLanguage: v })), "From")}
          <button
            className="iconbtn"
            style={{ marginBottom: 2, flexShrink: 0 }}
            onClick={() =>
              setDraft((p) => ({ ...p, originLanguage: p.destinationLanguage, destinationLanguage: p.originLanguage }))
            }
            disabled={busy}
            title="Swap languages"
          >
            ⇄
          </button>
          {langSelect(
            draft.destinationLanguage as any,
            (v) => setDraft((p) => ({ ...p, destinationLanguage: v })),
            "To",
          )}
        </div>

        <div style={{ marginTop: 8 }}>
          <div className="row" style={{ alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <label className="small muted">Expression</label>
            <button
              className="iconbtn"
              onClick={() => speak(draft.originExpression, String(draft.originLanguage ?? ""))}
              disabled={busy || !String(draft.originExpression ?? "").trim()}
              title="Speak"
            >
              🔊
            </button>
          </div>
          <input
            value={String(draft.originExpression ?? "")}
            onChange={(e) => setDraft((p) => ({ ...p, originExpression: e.target.value }))}
            disabled={busy}
            placeholder="e.g. aggiungere"
          />
        </div>

        {arrayEditor({
          label: "Possible translations",
          values: draft.possibleTranslations,
          onChange: (next) => setDraft((p) => ({ ...p, possibleTranslations: next })),
          speakLang: String(draft.destinationLanguage ?? ""),
          placeholder: "e.g. to add",
        })}

        {arrayEditor({
          label: `Examples (${translateLangFlag(draft.originLanguage as any)} origin)`,
          values: draft.examplesOrigin,
          onChange: (next) => setDraft((p) => ({ ...p, examplesOrigin: next })),
          speakLang: String(draft.originLanguage ?? ""),
          placeholder: "Example sentence…",
        })}

        {arrayEditor({
          label: `Examples (${translateLangFlag(draft.destinationLanguage as any)} destination)`,
          values: draft.examplesDestination,
          onChange: (next) => setDraft((p) => ({ ...p, examplesDestination: next })),
          speakLang: String(draft.destinationLanguage ?? ""),
          placeholder: "Translated example…",
        })}

        <div style={{ marginTop: 10 }}>
          <label className="small muted">Comments</label>
          <textarea
            value={String(draft.comments ?? "")}
            onChange={(e) => setDraft((p) => ({ ...p, comments: e.target.value }))}
            disabled={busy}
            style={{ minHeight: 120 }}
          />
        </div>

        <div style={{ marginTop: 10 }}>
          <label className="small muted">Further question</label>
          <input value={question} onChange={(e) => setQuestion(e.target.value)} disabled={busy} placeholder="Ask for nuance, register, usage…" />
          <div className="btnrow" style={{ marginTop: 10, justifyContent: "space-between" }}>
            <button onClick={repeat} disabled={busy}>
              {busy ? "Working…" : "Repeat LLM"}
            </button>
            <div className="btnrow">
              <button className="danger" onClick={del} disabled={busy}>
                Delete
              </button>
              <button className="primary" onClick={save} disabled={busy}>
                Save
              </button>
            </div>
          </div>
        </div>

        {err ? (
          <div style={{ marginTop: 10 }} className="error small">
            {err}
          </div>
        ) : null}
      </dialog>
    </>
  );
}
