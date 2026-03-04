import React from "react";
import { api } from "../api";
import type { ParsedAction } from "@shared/model";
import { ParsedActionZ } from "@shared/model";
import { z } from "zod";
import { getSpeechRecognition, type SpeechRecognitionLike } from "./speech";

function summarize(action: ParsedAction | null) {
  if (!action) return "—";
  switch (action.type) {
    case "append_item":
      return `Append item to ${action.listId ?? action.target}: ${(action.fields as any)?.text ?? ""}`;
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
    default:
      return "—";
  }
}

export function VoicePanel(props: { onCommitted: () => void }) {
  const SR = getSpeechRecognition();
  const [listening, setListening] = React.useState(false);
  const [transcript, setTranscript] = React.useState("");
  const [action, setAction] = React.useState<ParsedAction | null>(null);
  const [actionDraft, setActionDraft] = React.useState("");
  const [editJson, setEditJson] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const recRef = React.useRef<SpeechRecognitionLike | null>(null);
  const listeningRef = React.useRef(false);
  const micBaseRef = React.useRef<string>("");
  const micFinalRef = React.useRef<string>("");
  const micRestartTimerRef = React.useRef<number | null>(null);

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
    listeningRef.current = false;
    if (micRestartTimerRef.current) {
      window.clearTimeout(micRestartTimerRef.current);
      micRestartTimerRef.current = null;
    }
    recRef.current?.stop();
    setListening(false);
  }

  function start() {
    if (!SR) return;
    setErr(null);

    // Keep what's already in the textarea and append dictation to it.
    micBaseRef.current = transcript.trim();
    micFinalRef.current = "";

    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const chunk = String(res?.[0]?.transcript ?? "");
        if (!chunk) continue;
        if (res.isFinal) micFinalRef.current += chunk;
        else interim += chunk;
      }
      const base = micBaseRef.current;
      const finalPart = micFinalRef.current.trim();
      const interimPart = interim.trim();
      const merged = [base, finalPart, interimPart].filter(Boolean).join(" ").replaceAll(/\s+/g, " ").trim();
      setTranscript(merged);
    };
    rec.onerror = (ev) => {
      const code = String(ev?.error ?? "unknown");
      // Some browsers emit "no-speech" when you pause; keep the mic "on".
      if (listeningRef.current && ["no-speech", "audio-capture", "network"].includes(code)) return;
      setErr(`Speech error: ${code}`);
      stop();
    };
    rec.onend = () => {
      // Auto-restart to tolerate silence gaps while the mic toggle is "on".
      if (!listeningRef.current) {
        setListening(false);
        return;
      }
      if (micRestartTimerRef.current) window.clearTimeout(micRestartTimerRef.current);
      micRestartTimerRef.current = window.setTimeout(() => {
        try {
          recRef.current?.start();
        } catch {
          // ignore
        }
      }, 250);
    };
    recRef.current = rec;
    listeningRef.current = true;
    setListening(true);
    rec.start();
  }

  async function parse() {
    setBusy(true);
    setErr(null);
    try {
      const data = await api<{ action: ParsedAction; parseError?: string }>("/api/parse", {
        method: "POST",
        body: JSON.stringify({ transcript }),
      });
      setAction(data.action);
      setActionDraft(JSON.stringify(data.action, null, 2));
      setEditJson(false);
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

      // Small UX sugar for manual edits: accept `item` as alias for `fields` for append_item.
      if (json && typeof json === "object" && (json as any).type === "append_item") {
        if ((json as any).fields === undefined && (json as any).item !== undefined) {
          (json as any).fields = (json as any).item;
          delete (json as any).item;
        }
      }

      const parsed = ParsedActionZ.parse(json);
      await api("/api/commit", { method: "POST", body: JSON.stringify({ action: parsed }) });
      props.onCommitted();
      setErr(null);
      setAction(null);
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
          <button
            className="primary"
            onClick={listening ? stop : start}
            disabled={!SR || busy}
            title={!SR ? "SpeechRecognition not supported in this browser" : ""}
            data-mic="voice"
          >
            {listening ? "Stop 🎙" : "Mic 🎙"}
          </button>
        </div>
      </div>

      <label className="small muted">Transcript</label>
      <textarea value={transcript} onChange={(e) => setTranscript(e.target.value)} />

      <div style={{ marginTop: 10 }} className="btnrow">
        <button onClick={parse} disabled={busy || !transcript.trim()}>
          {busy ? "Working…" : "Parse"}
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
              <span className={action.valid ? "ok" : "error"}>{String(action.valid)}</span>
              <span className="muted">confidence</span>
              <span>{action.confidence.toFixed(2)}</span>
            </div>
          ) : (
            <div className="pill small">
              <span className="muted">Action</span>
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
