import React from "react";
import type { FieldDef } from "@shared/model";
import { TranslateModal } from "../TranslateModal";
import type { StatusValue } from "./constants";
import { ColorSelect, StatusSelect } from "./components";
import { DEFAULT_SPEECH_LANG_VALUE, SPEECH_LANG_OPTIONS, type SpeechRecognitionCtor } from "../speech";
import type { ItemRow, ListInfo } from "./types";
import type { SortLayer, fieldLabel as fieldLabelType } from "./utils";
import { TRANSLATE_LANG_VALUES, translateLangFlag, translateLangLabel, type TranslateLang, type TranslationPayload } from "../translate";

export function ListBrowserOverlays(props: {
  sortModalOpen: boolean;
  setSortModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  searchAllLists: boolean;
  activeList: ListInfo | null;
  sortDraft: SortLayer[];
  setSortDraft: React.Dispatch<React.SetStateAction<SortLayer[]>>;
  setSortLayers: React.Dispatch<React.SetStateAction<SortLayer[]>>;
  fieldLabel: typeof fieldLabelType;
  addOpen: boolean;
  setAddOpen: React.Dispatch<React.SetStateAction<boolean>>;
  addErr: string | null;
  setAddErr: React.Dispatch<React.SetStateAction<string | null>>;
  lists: ListInfo[];
  addListId: string;
  setAddListId: React.Dispatch<React.SetStateAction<string>>;
  addFields: Record<string, unknown>;
  setAddField: (name: string, value: unknown) => void;
  addStatus: StatusValue;
  setAddStatus: React.Dispatch<React.SetStateAction<StatusValue>>;
  addColor: string | null;
  setAddColor: React.Dispatch<React.SetStateAction<string | null>>;
  isAddTranslateMode: boolean;
  addTranslateFrom: TranslateLang | "";
  setAddTranslateFrom: React.Dispatch<React.SetStateAction<TranslateLang | "">>;
  addTranslateTo: TranslateLang | "";
  setAddTranslateTo: React.Dispatch<React.SetStateAction<TranslateLang | "">>;
  busy: boolean;
  speechLang: string;
  setSpeechLang: React.Dispatch<React.SetStateAction<string>>;
  speechRecognition: SpeechRecognitionCtor | null;
  addListening: boolean;
  lastAddMicClickRef: React.MutableRefObject<number>;
  stopAddMic: () => void;
  startAddMic: () => void;
  activeAddList: () => ListInfo | null;
  renderAddFieldInput: (list: ListInfo, fieldName: string, def: FieldDef) => React.ReactNode;
  submitAddTranslate: () => Promise<void>;
  submitAdd: () => Promise<void>;
  validateAddForm: () => string | null;
  fieldEditOpen: boolean;
  setFieldEditOpen: React.Dispatch<React.SetStateAction<boolean>>;
  fieldEditRow: ItemRow | null;
  setFieldEditRow: React.Dispatch<React.SetStateAction<ItemRow | null>>;
  fieldEditName: string;
  fieldEditValue: string;
  setFieldEditValue: React.Dispatch<React.SetStateAction<string>>;
  confirmFieldEdit: () => Promise<void>;
  fieldEditErr: string | null;
  setFieldEditErr: React.Dispatch<React.SetStateAction<string | null>>;
  editOpen: boolean;
  setEditOpen: React.Dispatch<React.SetStateAction<boolean>>;
  editRow: ItemRow | null;
  editDraft: string;
  setEditDraft: React.Dispatch<React.SetStateAction<string>>;
  editOriginalDraft: string;
  confirmEdit: () => Promise<void>;
  editErr: string | null;
  setEditErr: React.Dispatch<React.SetStateAction<string | null>>;
  translateOpen: boolean;
  translateRow: ItemRow | null;
  translateInitial: TranslationPayload | null;
  closeTranslateModal: () => void;
  llmRefine: (draft: TranslationPayload, question: string) => Promise<{ translation: TranslationPayload; answer: string }>;
  saveTranslation: (next: TranslationPayload) => Promise<void>;
  deleteTranslation: () => Promise<void>;
  undoToast: { id: string; label: string } | null;
  executeUndo: (ids: string[], confirmed: boolean) => Promise<void>;
  undoBusy: boolean;
  dismissUndoToast: () => void;
  undoConfirm: { ids: string[] } | null;
  setUndoConfirm: React.Dispatch<React.SetStateAction<{ ids: string[] } | null>>;
  err: string | null;
}) {
  const {
    sortModalOpen,
    setSortModalOpen,
    searchAllLists,
    activeList,
    sortDraft,
    setSortDraft,
    setSortLayers,
    fieldLabel,
    addOpen,
    setAddOpen,
    addErr,
    setAddErr,
    lists,
    addListId,
    setAddListId,
    addFields,
    setAddField,
    addStatus,
    setAddStatus,
    addColor,
    setAddColor,
    isAddTranslateMode,
    addTranslateFrom,
    setAddTranslateFrom,
    addTranslateTo,
    setAddTranslateTo,
    busy,
    speechLang,
    setSpeechLang,
    speechRecognition,
    addListening,
    lastAddMicClickRef,
    stopAddMic,
    startAddMic,
    activeAddList,
    renderAddFieldInput,
    submitAddTranslate,
    submitAdd,
    validateAddForm,
    fieldEditOpen,
    setFieldEditOpen,
    fieldEditRow,
    setFieldEditRow,
    fieldEditName,
    fieldEditValue,
    setFieldEditValue,
    confirmFieldEdit,
    fieldEditErr,
    setFieldEditErr,
    editOpen,
    setEditOpen,
    editRow,
    editDraft,
    setEditDraft,
    editOriginalDraft,
    confirmEdit,
    editErr,
    setEditErr,
    translateOpen,
    translateRow,
    translateInitial,
    closeTranslateModal,
    llmRefine,
    saveTranslation,
    deleteTranslation,
    undoToast,
    executeUndo,
    undoBusy,
    dismissUndoToast,
    undoConfirm,
    setUndoConfirm,
    err,
  } = props;

  const builtinSortFields: { key: string; label: string }[] = [
    { key: "text", label: "Text" },
    { key: "priority", label: "Priority" },
    { key: "status", label: "Status" },
    { key: "color", label: "Color" },
    { key: "createdAt", label: "Created" },
  ];
  if (searchAllLists) builtinSortFields.push({ key: "listId", label: "List" });
  const customFields = activeList
    ? Object.entries(activeList.fields)
        .filter(([k]) => !["order", "archivedAt", "unarchivedAt", "text", "priority", "status", "color"].includes(k))
        .map(([k]) => ({ key: k, label: fieldLabel(k) }))
    : [];
  const allSortFields = [...builtinSortFields, ...customFields];
  const usedKeys = new Set(sortDraft.map((l) => l.key));

  function draftMove(i: number, dir: -1 | 1) {
    setSortDraft((prev) => {
      const next = [...prev];
      const swap = i + dir;
      if (swap < 0 || swap >= next.length) return prev;
      [next[i], next[swap]] = [next[swap]!, next[i]!];
      return next;
    });
  }

  return (
    <>
      {sortModalOpen ? (
        <>
          <div className="dialogOverlay" onClick={() => setSortModalOpen(false)} />
          <dialog open className="dialog" style={{ minWidth: 340, maxWidth: 480 }}>
            <div className="topbar" style={{ marginBottom: 14 }}>
              <div>
                <div className="title">Sort by</div>
                <div className="muted small">Drag or reorder sort levels</div>
              </div>
              <div className="btnrow">
                <button onClick={() => setSortModalOpen(false)}>Close</button>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
              {sortDraft.length === 0 && (
                <div className="muted small" style={{ padding: "8px 0" }}>No sort applied — rows appear in natural order.</div>
              )}
              {sortDraft.map((layer, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    <button className="iconbtn" style={{ padding: "0 6px", fontSize: 11, lineHeight: 1.4 }} onClick={() => draftMove(i, -1)} disabled={i === 0} title="Move up">▲</button>
                    <button className="iconbtn" style={{ padding: "0 6px", fontSize: 11, lineHeight: 1.4 }} onClick={() => draftMove(i, 1)} disabled={i === sortDraft.length - 1} title="Move down">▼</button>
                  </div>
                  <span className="muted small" style={{ width: 14, textAlign: "right", flexShrink: 0 }}>{i + 1}.</span>
                  <select
                    value={layer.key}
                    style={{ flex: 1 }}
                    onChange={(e) => {
                      const key = e.target.value;
                      setSortDraft((prev) => prev.map((l, j) => j === i ? { ...l, key } : l));
                    }}
                  >
                    {allSortFields.map((f) => (
                      <option key={f.key} value={f.key} disabled={f.key !== layer.key && usedKeys.has(f.key)}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  <button
                    className="iconbtn"
                    style={{ flexShrink: 0, minWidth: 56 }}
                    onClick={() => setSortDraft((prev) => prev.map((l, j) => j === i ? { ...l, dir: l.dir === "asc" ? "desc" : "asc" } : l))}
                    title="Toggle direction"
                  >
                    {layer.dir === "asc" ? "↑ Asc" : "↓ Desc"}
                  </button>
                  <button
                    className="iconbtn"
                    style={{ flexShrink: 0, color: "var(--danger)", borderColor: "rgba(255,107,107,0.4)" }}
                    onClick={() => setSortDraft((prev) => prev.filter((_, j) => j !== i))}
                    title="Remove"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <button
                className="iconbtn"
                onClick={() => {
                  const available = allSortFields.find((f) => !usedKeys.has(f.key));
                  if (!available) return;
                  setSortDraft((prev) => [...prev, { key: available.key, dir: "asc" }]);
                }}
                disabled={sortDraft.length >= allSortFields.length}
              >
                + Add level
              </button>
              <div className="btnrow">
                <button onClick={() => setSortDraft([])}>Clear all</button>
                <button className="primary" onClick={() => { setSortLayers(sortDraft.length > 0 ? sortDraft : [{ key: "createdAt", dir: "desc" }]); setSortModalOpen(false); }}>
                  Apply
                </button>
              </div>
            </div>
          </dialog>
        </>
      ) : null}

      {addOpen ? (
        <>
          <div className="dialogOverlay" onClick={() => { setAddOpen(false); setAddErr(null); }} />
          <dialog open className="dialog">
            <div className="topbar" style={{ marginBottom: 12 }}>
              <div>
                <div className="title">Add item</div>
                <div className="muted small">Manual add (no voice parsing)</div>
              </div>
              <div className="btnrow">
                <button onClick={() => { setAddOpen(false); setAddErr(null); }}>Close</button>
              </div>
            </div>
            <div className="formRow">
              <div className="formCol">
                <label className="small muted">List</label>
                <select value={addListId || ""} onChange={(e) => setAddListId(e.target.value)}>
                  {lists.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
                </select>
              </div>
              <div className="formCol">
                <label className="small muted">Priority</label>
                <select value={String((addFields.priority as any) ?? 3)} onChange={(e) => setAddField("priority", Number(e.target.value))}>
                  {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div className="formCol">
                <label className="small muted">Status</label>
                <StatusSelect value={addStatus} onChange={setAddStatus} />
              </div>
              <div className="formCol">
                <label className="small muted">Color</label>
                <ColorSelect value={addColor} onChange={setAddColor} />
              </div>
            </div>
            {isAddTranslateMode && (
              <div className="formRow" style={{ alignItems: "flex-end", marginTop: 8 }}>
                <div className="formCol" style={{ minWidth: 120 }}>
                  <label className="small muted">From</label>
                  <select value={addTranslateFrom} onChange={(e) => setAddTranslateFrom(e.target.value as TranslateLang | "")} disabled={busy}>
                    <option value="">—</option>
                    {TRANSLATE_LANG_VALUES.map((v) => <option key={v} value={v}>{translateLangFlag(v)} {translateLangLabel(v)}</option>)}
                  </select>
                </div>
                <button className="iconbtn" style={{ marginBottom: 2, flexShrink: 0 }} onClick={() => { const t = addTranslateFrom; setAddTranslateFrom(addTranslateTo); setAddTranslateTo(t); }} disabled={busy} title="Swap languages">⇄</button>
                <div className="formCol" style={{ minWidth: 120 }}>
                  <label className="small muted">To</label>
                  <select value={addTranslateTo} onChange={(e) => setAddTranslateTo(e.target.value as TranslateLang | "")} disabled={busy}>
                    <option value="">—</option>
                    {TRANSLATE_LANG_VALUES.map((v) => <option key={v} value={v}>{translateLangFlag(v)} {translateLangLabel(v)}</option>)}
                  </select>
                </div>
              </div>
            )}
            <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
              <label className="small muted">Text *</label>
              <div className="row" style={{ alignItems: "center", gap: 8 }}>
                <select value={speechLang || DEFAULT_SPEECH_LANG_VALUE} onChange={(e) => setSpeechLang(e.target.value)} disabled={!speechRecognition} title="Speech language">
                  {SPEECH_LANG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button
                  className="iconbtn"
                  onClick={() => {
                    const now = Date.now();
                    if (lastAddMicClickRef.current !== null && now - lastAddMicClickRef.current < 400) return;
                    lastAddMicClickRef.current = now;
                    if (addListening) stopAddMic();
                    else startAddMic();
                  }}
                  disabled={!speechRecognition}
                  title={!speechRecognition ? "SpeechRecognition not supported in this browser" : ""}
                  data-mic="add"
                >
                  {addListening ? "Stop 🎙" : "Mic 🎙"}
                </button>
              </div>
            </div>
            <textarea value={String(addFields.text ?? "")} onChange={(e) => setAddField("text", e.target.value)} />

            {!isAddTranslateMode && activeAddList() ? (
              <div style={{ marginTop: 10 }}>
                <div className="muted small" style={{ marginBottom: 6 }}>Extra fields</div>
                <div className="formRow">
                  {Object.entries(activeAddList()!.fields)
                    .filter(([name]) => !["text", "priority", "color", "order", "status", "archivedAt", "unarchivedAt"].includes(name))
                    .map(([name, def]) => renderAddFieldInput(activeAddList()!, name, def))}
                </div>
              </div>
            ) : null}

            <div style={{ marginTop: 12 }} className="btnrow">
              {isAddTranslateMode ? (
                <button className="primary" onClick={submitAddTranslate} disabled={!String(addFields.text ?? "").trim() || busy}>
                  {busy ? "Working…" : "Run LLM"}
                </button>
              ) : (
                <button className="primary" onClick={submitAdd} disabled={Boolean(validateAddForm()) || busy}>
                  {busy ? "Working…" : "Add"}
                </button>
              )}
              <button className="danger" onClick={() => { setAddOpen(false); stopAddMic(); setAddErr(null); }}>Cancel</button>
            </div>

            {addErr ? <div style={{ marginTop: 10 }} className="error small">{addErr}</div> : null}
          </dialog>
        </>
      ) : null}

      {fieldEditOpen && fieldEditRow ? (
        <>
          <div className="dialogOverlay" onClick={() => { setFieldEditOpen(false); setFieldEditRow(null); }} />
          <dialog open className="dialog">
            <div className="topbar" style={{ marginBottom: 12 }}>
              <div>
                <div className="title">Edit {fieldLabel(fieldEditName)}</div>
                <div className="muted small">{lists.find((l) => l.id === fieldEditRow.__listId)?.title ?? fieldEditRow.__listId}</div>
              </div>
              <div className="btnrow">
                <button onClick={() => { setFieldEditOpen(false); setFieldEditRow(null); }}>Close</button>
              </div>
            </div>
            {(() => {
              const def = lists.find((l) => l.id === fieldEditRow.__listId)?.fields[fieldEditName];
              if (!def || def.type === "string" || fieldEditName === "text") {
                return <textarea value={fieldEditValue} onChange={(e) => setFieldEditValue(e.target.value)} autoFocus style={{ minHeight: 120 }} />;
              }
              if (def.type === "int" || def.type === "float") {
                return <input type="number" value={fieldEditValue} step={def.type === "float" ? "any" : "1"} onChange={(e) => setFieldEditValue(e.target.value)} autoFocus />;
              }
              if (def.type === "date") {
                return <input type="date" value={fieldEditValue.slice(0, 10)} onChange={(e) => setFieldEditValue(e.target.value)} autoFocus />;
              }
              if (def.type === "time") {
                return <input type="time" value={fieldEditValue} onChange={(e) => setFieldEditValue(e.target.value)} autoFocus />;
              }
              if (def.type === "json") {
                return <textarea value={fieldEditValue} onChange={(e) => setFieldEditValue(e.target.value)} autoFocus style={{ minHeight: 160, fontFamily: "monospace" }} />;
              }
              return <input value={fieldEditValue} onChange={(e) => setFieldEditValue(e.target.value)} autoFocus />;
            })()}
            <div style={{ marginTop: 10 }} className="btnrow">
              <button className="primary" onClick={confirmFieldEdit}>Save</button>
              <button className="danger" onClick={() => { setFieldEditOpen(false); setFieldEditRow(null); setFieldEditErr(null); }}>Cancel</button>
            </div>
            {fieldEditErr ? <div style={{ marginTop: 10 }} className="error small">{fieldEditErr}</div> : null}
          </dialog>
        </>
      ) : null}

      {editOpen && editRow ? (
        <>
          <div className="dialogOverlay" onClick={() => { setEditOpen(false); setEditDraft(""); setEditErr(null); }} />
          <dialog open className="dialog">
            <div className="topbar" style={{ marginBottom: 12 }}>
              <div>
                <div className="title">Edit item (JSON)</div>
                <div className="muted small">{lists.find((l) => l.id === editRow.__listId)?.title ?? editRow.__listId} • {editRow.id.slice(0, 12)}</div>
              </div>
              <div className="btnrow">
                <button onClick={() => setEditOpen(false)}>Close</button>
              </div>
            </div>
            <label className="small muted">Fields JSON (patch)</label>
            <textarea value={editDraft} onChange={(e) => { setEditDraft(e.target.value); setEditErr(null); }} style={{ fontFamily: "monospace" }} />
            <div style={{ marginTop: 10 }} className="btnrow">
              <button className="primary" onClick={confirmEdit} disabled={!editDraft.trim() || editDraft === editOriginalDraft} title={editDraft === editOriginalDraft ? "No changes" : ""}>
                Save
              </button>
              <button className="danger" onClick={() => { setEditOpen(false); setEditDraft(""); setEditErr(null); }}>Cancel</button>
            </div>
            {editErr ? <div style={{ marginTop: 10 }} className="error small">{editErr}</div> : null}
          </dialog>
        </>
      ) : null}

      {translateOpen && translateRow && translateInitial ? (
        <TranslateModal
          open={translateOpen}
          title={translateInitial.originExpression ? String(translateInitial.originExpression) : "Translate"}
          initial={translateInitial}
          onClose={closeTranslateModal}
          onRepeat={async (draft, question) => await llmRefine(draft, question)}
          onSave={saveTranslation}
          onDelete={deleteTranslation}
        />
      ) : null}

      {undoToast ? (
        <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "10px 16px", display: "flex", alignItems: "center", gap: 12, zIndex: 1000, color: "#e7ecff", boxShadow: "0 4px 20px rgba(0,0,0,0.4)" }}>
          <span className="small">{undoToast.label}</span>
          <button onClick={() => executeUndo([undoToast.id], false)} disabled={undoBusy} style={{ background: "#1a90d4", color: "#fff", borderColor: "#1a90d4" }}>
            Undo
          </button>
          <button className="iconbtn" onClick={dismissUndoToast}>×</button>
        </div>
      ) : null}

      {undoConfirm ? (
        <>
          <div className="dialogOverlay" onClick={() => setUndoConfirm(null)} />
          <dialog open className="dialog">
            <div className="topbar" style={{ marginBottom: 12 }}>
              <div className="title">Confirm undo</div>
            </div>
            <p className="small" style={{ marginBottom: 16 }}>
              This will undo all later changes on this/these items. Are you sure?
            </p>
            <div className="btnrow">
              <button className="primary" onClick={async () => { const ids = undoConfirm.ids; setUndoConfirm(null); await executeUndo(ids, true); }}>
                Yes, undo all
              </button>
              <button onClick={() => setUndoConfirm(null)}>Cancel</button>
            </div>
          </dialog>
        </>
      ) : null}

      {err ? <div style={{ marginTop: 10 }} className="error small">{err}</div> : null}

      {busy ? (
        <div style={{ position: "fixed", inset: 0, zIndex: 500, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0, 0, 0, 0.35)", backdropFilter: "blur(2px)", WebkitBackdropFilter: "blur(2px)" }}>
          <div className="spinner spinnerLg" title="Loading…" />
        </div>
      ) : null}
    </>
  );
}
