import React from "react";
import { api } from "../api";
import type { ParsedAction } from "@shared/model";
import { ParsedActionZ } from "@shared/model";
import { z } from "zod";
import {
  DEFAULT_SPEECH_LANG_VALUE,
  SPEECH_LANG_OPTIONS,
  SPEECH_LANG_STORAGE_KEY,
  getSpeechRecognition,
  resolveSpeechLang,
  type SpeechRecognitionLike,
} from "./speech";

function summarize(action: ParsedAction | null) {
  if (!action) return "—";
  switch (action.type) {
    case "append_item":
      return `Append item to ${action.listId ?? action.target}: ${(action.fields as any)?.text ?? ""}`;
    case "batch":
      return `Batch: ${action.label} (${action.actions.length} actions)`;
    case "update_item":
      return `Update ${action.itemId} in ${action.listId ?? action.target}`;
    case "delete_item":
      return `Delete ${action.itemId} from ${action.listId ?? action.target}`;
    case "move_item":
      return `Move ${action.itemId} from ${action.fromListId} → ${action.toListId}`;
    case "create_list":
      return `Create list: ${action.title} (${action.listId ?? "auto id"})`;
    case "add_fields":
      return `Add fields to ${action.listId ?? action.target}: ${action.fieldsToAdd
        .map((f) => f.name)
        .join(", ")}`;
    case "remove_fields":
      return `Remove fields from ${action.listId ?? action.target}: ${action.fieldsToRemove.join(", ")}`;
    case "delete_list":
      return `Delete entire list: ${(action as any).listId ?? (action as any).target}`;
    case "translate_intent":
      return `Translate: ${(action as any).input ?? ""}`;
    default:
      return "—";
  }
}

export function VoicePanel(props: { onCommitted: () => void; onTranslateIntent?: (input: string) => void }) {
  const [listening, setListening] = React.useState(false);
  const [transcript, setTranscript] = React.useState("");
  const [action, setAction] = React.useState<ParsedAction | null>(null);
  const [parseDebug, setParseDebug] = React.useState<any>(null);
  const [actionDraft, setActionDraft] = React.useState("");
  const [editJson, setEditJson] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const audioChunksRef = React.useRef<Blob[]>([]);
  const streamRef = React.useRef<MediaStream | null>(null);
  const micHoldActiveRef = React.useRef(false);
  const suppressMicClickRef = React.useRef(false);
  const coarsePointerRef = React.useRef(false);
  const [speechLang, setSpeechLang] = React.useState<string>(() => {
    try {
      return window.localStorage.getItem(SPEECH_LANG_STORAGE_KEY) ?? DEFAULT_SPEECH_LANG_VALUE;
    } catch {
      return DEFAULT_SPEECH_LANG_VALUE;
    }
  });

  React.useEffect(() => {
    coarsePointerRef.current =
      (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)")?.matches) ||
      (typeof navigator !== "undefined" && (navigator.maxTouchPoints ?? 0) > 0);
  }, []);

  React.useEffect(() => {
    try {
      window.localStorage.setItem(SPEECH_LANG_STORAGE_KEY, speechLang);
    } catch {
      // ignore
    }
  }, [speechLang]);

  React.useEffect(() => {
    if (!listening) return;
    function onDocClick(ev: MouseEvent) {
      const el = ev.target as HTMLElement | null;
      const btn = el?.closest?.("button");
      if (!btn) return;
      if (btn.getAttribute("data-mic") === "voice") return;
      stop();
    }
    document.addEventListener("click", onDocClick, true);
    return () => document.removeEventListener("click", onDocClick, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening]);

  function stop() {
    const mr = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    setListening(false);
    if (mr && mr.state !== "inactive") {
      try { mr.stop(); } catch { /* ignore */ }
    } else {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }

  async function start() {
    if (listening) return;
    setErr(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e: any) {
      setErr(`Microphone access denied: ${String(e?.message ?? e)}`);
      return;
    }
    streamRef.current = stream;
    audioChunksRef.current = [];
    const mr = new MediaRecorder(stream);
    mediaRecorderRef.current = mr;
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunksRef.current.push(e.data);
    };
    mr.onstop = async () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const chunks = audioChunksRef.current;
      audioChunksRef.current = [];
      if (chunks.length === 0) return;
      const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
      setBusy(true);
      setErr(null);
      try {
        const fd = new FormData();
        fd.append("audio", blob, "recording");
        if (speechLang !== "auto") fd.append("lang", speechLang);
        const res = await fetch(`${API_BASE}/transcribe`, {
          method: "POST",
          body: fd,
          credentials: "include",
        });
        const data = await res.json() as any;
        if (!res.ok) throw new Error(data.details ?? `HTTP ${res.status}`);
        const text = String(data.text ?? "").trim();
        if (text) setTranscript((prev) => [prev.trim(), text].filter(Boolean).join(" "));
      } catch (e: any) {
        setErr(String(e?.message ?? e));
      } finally {
        setBusy(false);
      }
    };
    mr.start();
    setListening(true);
  }

  function onMicPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (!coarsePointerRef.current) return;
    if (busy) return;
    suppressMicClickRef.current = true;
    micHoldActiveRef.current = true;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (!listening) start();
  }

  function onMicPointerUp(e?: React.PointerEvent<HTMLButtonElement>) {
    if (!coarsePointerRef.current) return;
    if (!micHoldActiveRef.current) return;
    micHoldActiveRef.current = false;
    if (e) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
    stop();
    window.setTimeout(() => {
      suppressMicClickRef.current = false;
    }, 0);
  }

  async function parse(forceLlm?: boolean) {
    setBusy(true);
    setErr(null);
    try {
      const data = await api<{ action: ParsedAction; parseError?: string | null; parseDebug?: any }>("/parse", {
        method: "POST",
        body: JSON.stringify({ transcript, forceLlm: Boolean(forceLlm) }),
      });
      setAction(data.action);
      setActionDraft(JSON.stringify(data.action, null, 2));
      setEditJson(false);
      setParseDebug((data as any).parseDebug ?? null);
      if (data.parseError) setErr(data.parseError);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setErr(null);
    try {
      const json = editJson ? JSON.parse(actionDraft) : action;
      if (json && typeof json === "object" && (json as any).type === "append_item") {
        if ((json as any).fields === undefined && (json as any).item !== undefined) {
          (json as any).fields = (json as any).item;
          delete (json as any).item;
        }
      }

      // Intercept translate_intent before Zod parse — it is client-only and never committed
      if (json && typeof json === "object" && (json as any).type === "translate_intent") {
        props.onTranslateIntent?.((json as any).input ?? transcript);
        cancel();
        return;
      }

      const parsed = ParsedActionZ.parse(json);

      if (parsed.type === "delete_list") {
        const listName = (parsed as any).listId ?? (parsed as any).target ?? "this list";
        const confirmed = window.confirm(`Are you sure you want to remove the entire list "${listName}"?`);
        if (!confirmed) return;
      }

      await api("/commit", { method: "POST", body: JSON.stringify({ action: parsed }) });
      props.onCommitted();
      setErr(null);
      setAction(null);
      setParseDebug(null);
      setActionDraft("");
      setTranscript("");
    } catch (e: any) {
      if (e instanceof z.ZodError) {
        const msg = e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
        const hint = e.issues.some((i) => (i as any).keys?.includes?.("item"))
          ? "\nHint: for append_item use `fields: { ... }` (not `item`)."
          : "";
        setErr(`Invalid action JSON:\n${msg}${hint}`);
      } else {
        setErr(String(e?.message ?? e));
      }
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    stop();
    setTranscript("");
    setAction(null);
    setParseDebug(null);
    setActionDraft("");
    setEditJson(false);
    setErr(null);
  }

  return (
    <div className="card">
      <div className="topbar" style={{ marginBottom: 10 }}>
        <div>
          <div className="title">Voice → Action → Confirm</div>
          <div className="muted small">Transcript → strict JSON action → validated commit</div>
        </div>
        <div className="btnrow">
          <select
            value={speechLang}
            onChange={(e) => setSpeechLang(e.target.value)}
            disabled={busy}
            title="Speech language"
          >
            {SPEECH_LANG_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            className="primary"
            onClick={() => {
              if (suppressMicClickRef.current) return;
              if (coarsePointerRef.current) return;
              if (listening) stop();
              else start();
            }}
            onPointerDown={onMicPointerDown}
            onPointerUp={onMicPointerUp}
            onPointerCancel={onMicPointerUp}
            disabled={busy}
            data-mic="voice"
            title=""
          >
            {listening ? "Stop 🎙" : "Mic 🎙"}
          </button>
        </div>
      </div>

      <label className="small muted">Transcript</label>
      <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} />

      <div style={{ marginTop: 10 }} className="btnrow">
        <button onClick={() => parse(Boolean(action))} disabled={busy || !transcript.trim()}>
          {busy ? "Working…" : action ? "Force LLM" : "Parse"}
        </button>
        <button
          className="primary"
          onClick={commit}
          disabled={busy || (editJson ? !actionDraft.trim() : !action || !(action as any).valid)}
          title={!editJson && action && !(action as any).valid ? "Action.valid=false; edit/parse again" : ""}
        >
          Confirm & Commit
        </button>
        <button onClick={() => setEditJson((v) => !v)} disabled={!action || busy}>
          {editJson ? "Hide JSON" : "Edit JSON"}
        </button>
        <button className="danger" onClick={cancel} disabled={busy}>
          Cancel
        </button>
      </div>

      <div style={{ marginTop: 10 }} className="row">
        <div className="col">
          <div className="pill small">
            <span className="muted">Preview</span>
            <span>{summarize(action)}</span>
          </div>
        </div>
        <div className="col">
          {action ? (
            <div className="pill small">
              <span className="muted">valid</span>
              <span className={(action as any).valid ? "ok" : "error"}>{String((action as any).valid)}</span>
              <span className="muted">confidence</span>
              <span>{Number((action as any).confidence ?? 0).toFixed(2)}</span>
            </div>
          ) : (
            <div className="pill small">
              <span className="muted">Action</span>
              <span>—</span>
            </div>
          )}
        </div>
        <div className="col">
          {parseDebug ? (
            <div className="pill small" title={parseDebug?.requestId ? `requestId: ${parseDebug.requestId}` : ""}>
              <span className="muted">parser</span>
              <span>
                {String(parseDebug.method ?? "—")}
                {parseDebug.model ? ` (${parseDebug.model})` : ""}
                {parseDebug.rule ? ` / ${parseDebug.rule}` : ""}
              </span>
            </div>
          ) : (
            <div className="pill small">
              <span className="muted">parser</span>
              <span>—</span>
            </div>
          )}
        </div>
      </div>

      {editJson ? (
        <div style={{ marginTop: 10 }}>
          <label className="small muted">Action JSON (editable)</label>
          <textarea value={actionDraft} onChange={(e) => setActionDraft(e.target.value)} />
        </div>
      ) : null}

      {err ? (
        <div style={{ marginTop: 10 }} className="error small">
          {err}
        </div>
      ) : null}
    </div>
  );
}
