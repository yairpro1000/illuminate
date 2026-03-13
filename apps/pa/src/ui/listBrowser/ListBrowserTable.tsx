import React from "react";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { TRANSLATE_LIST_ID, translateLangFlag } from "../translate";
import { ColorPicker, SortableTr, StatusPicker, ToggleSwitch } from "./components";
import { fieldLabel, hexToRgba, linkifyText, type SortLayer } from "./utils";
import type { ItemRow, ListInfo } from "./types";

const EDITABLE_FIELD_TYPES = new Set(["string", "int", "float", "date", "time", "json"]);

export function ListBrowserTable(props: {
  undoMode: boolean;
  reorderMode: boolean;
  sensors: any;
  onDragEnd: ((ev: any) => void) | undefined;
  reorderIds: string[];
  displayRows: ItemRow[];
  selectedIds: Set<string>;
  toggleSelect: (id: string) => void;
  toggleSelectAll: () => void;
  busy: boolean;
  searchAllLists: boolean;
  listId: string;
  reorderPriority: number;
  expandedIds: Set<string>;
  setColor: (listId: string, itemId: string, color: string | null) => Promise<void>;
  openTranslateModal: (row: ItemRow) => void;
  openFieldEdit: (row: ItemRow, fieldName: string) => void;
  setStatusAny: (listId: string, itemId: string, status: any) => Promise<void>;
  archiveItem: (listId: string, itemId: string) => Promise<void>;
  unarchiveItem: (listId: string, itemId: string) => Promise<void>;
  setPriority: (listId: string, itemId: string, priority: number) => Promise<void>;
  toggleExpand: (id: string) => void;
  moveRow: (fromListId: string, toListId: string, itemId: string) => Promise<void>;
  lists: ListInfo[];
  activeList: ListInfo | null;
  expandCustomFields: string[];
  commit: (action: any, opts?: { refresh?: boolean; expectedItemUpdatedAt?: string; undoLabel?: string }) => Promise<any>;
  del: (listId: string, itemId: string) => Promise<void>;
  openEdit: (row: ItemRow) => void;
  sortLayers: SortLayer[];
  toggleSort: (key: string) => void;
}) {
  const {
    undoMode,
    reorderMode,
    sensors,
    onDragEnd,
    reorderIds,
    displayRows,
    selectedIds,
    toggleSelect,
    toggleSelectAll,
    busy,
    searchAllLists,
    listId,
    reorderPriority,
    expandedIds,
    setColor,
    openTranslateModal,
    openFieldEdit,
    setStatusAny,
    archiveItem,
    unarchiveItem,
    setPriority,
    toggleExpand,
    moveRow,
    lists,
    activeList,
    expandCustomFields,
    commit,
    del,
    openEdit,
    sortLayers,
    toggleSort,
  } = props;

  return (
    <>
      <div style={{ display: undoMode ? "none" : undefined }}>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorderMode ? onDragEnd : undefined}>
          <SortableContext items={reorderMode ? reorderIds : []} strategy={verticalListSortingStrategy}>
            <table>
              <thead className="stickyHead">
                <tr>
                  {reorderMode ? (
                    <th style={{ width: "100%" }} onClick={() => toggleSort("text")}>text</th>
                  ) : (
                    <>
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          checked={displayRows.length > 0 && selectedIds.size === displayRows.length}
                          onChange={toggleSelectAll}
                          style={{ width: 16, height: 16, cursor: "pointer" }}
                          title="Select all"
                          aria-label="Select all"
                        />
                      </th>
                      <th className="colColor" style={{ width: 36 }} onClick={() => toggleSort("color")} />
                      <th onClick={() => toggleSort("text")}>text</th>
                      <th style={{ width: 130 }} onClick={() => toggleSort("status")}>status</th>
                      <th className="colPriority" style={{ width: 56 }} onClick={() => toggleSort("priority")}>P</th>
                      <th style={{ width: 32 }} />
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {displayRows.map((it) => {
                  const isArchived = typeof (it as any).archivedAt === "string" && String((it as any).archivedAt).trim();
                  const draggable = reorderMode && !searchAllLists && it.__listId === listId && (it.priority ?? 3) === reorderPriority;
                  const isTranslateRow = it.__listId === TRANSLATE_LIST_ID;
                  const rowStyle: React.CSSProperties = {
                    background: typeof it.color === "string" && it.color ? hexToRgba(it.color, 0.12) : undefined,
                    opacity: isArchived ? 0.65 : undefined,
                  };
                  const isExpanded = expandedIds.has(it.id);

                  if (reorderMode) {
                    return (
                      <SortableTr
                        key={`${it.__listId}:${it.id}`}
                        id={it.id}
                        disabled={!draggable}
                        fullRowDrag
                        style={{ ...rowStyle, cursor: draggable ? "grab" : undefined }}
                        render={() => (
                          <td style={{ width: "100%" }}>
                            {linkifyText(String(it.text ?? ""))}
                          </td>
                        )}
                      />
                    );
                  }

                  return (
                    <React.Fragment key={`${it.__listId}:${it.id}`}>
                      <tr style={rowStyle}>
                        <td style={{ width: 36 }}>
                          <input
                            type="checkbox"
                            checked={selectedIds.has(it.id)}
                            onChange={() => toggleSelect(it.id)}
                            style={{ width: 16, height: 16, cursor: "pointer" }}
                            aria-label="Select row"
                          />
                        </td>
                        <td className="colColor" style={{ width: 36 }}>
                          <ColorPicker value={it.color as any} onChange={(c) => setColor(it.__listId, it.id, c)} />
                        </td>
                        <td>
                          <div
                            className="editableCell"
                            onClick={(e) => {
                              if ((e.target as Element).closest?.(".menu")) return;
                              if (document.querySelector(".menu[open]")) return;
                              isTranslateRow ? openTranslateModal(it) : openFieldEdit(it, "text");
                            }}
                            title={isTranslateRow ? "Open translate modal" : "Click to edit"}
                            style={isTranslateRow ? { cursor: "pointer" } : undefined}
                          >
                            {isTranslateRow ? (() => {
                              const origin = typeof (it as any).originLanguage === "string" ? String((it as any).originLanguage) : "";
                              const dest = typeof (it as any).destinationLanguage === "string" ? String((it as any).destinationLanguage) : "";
                              const expr = typeof (it as any).originExpression === "string" ? String((it as any).originExpression) : String(it.text ?? "");
                              const translations = Array.isArray((it as any).possibleTranslations) ? (it as any).possibleTranslations : [];
                              const first = translations.length ? String(translations[0] ?? "") : "";
                              return (
                                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                    <span className="pill small" style={{ padding: "2px 8px" }}>
                                      {translateLangFlag(origin as any)}→{translateLangFlag(dest as any)}
                                    </span>
                                    <span>{linkifyText(expr)}</span>
                                  </div>
                                  {first ? <div className="small muted">{first}</div> : null}
                                </div>
                              );
                            })() : linkifyText(String(it.text ?? ""))}
                          </div>
                          <div className="small muted">{it.id.slice(0, 8)}</div>
                        </td>
                        <td style={{ width: 130 }}>
                          <StatusPicker
                            value={(it as any).status}
                            archived={Boolean(isArchived)}
                            onChange={(s) => setStatusAny(it.__listId, it.id, s)}
                            onArchive={() => archiveItem(it.__listId, it.id)}
                            onUnarchive={() => unarchiveItem(it.__listId, it.id)}
                          />
                        </td>
                        <td className="colPriority" style={{ width: 56 }}>
                          <select value={String(it.priority ?? 3)} onChange={(e) => setPriority(it.__listId, it.id, Number(e.target.value))}>
                            {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{p}</option>)}
                          </select>
                        </td>
                        <td style={{ width: 32 }}>
                          <button
                            className="iconbtn"
                            onClick={() => toggleExpand(it.id)}
                            title={isExpanded ? "Collapse" : "More"}
                            aria-label={isExpanded ? "Collapse" : "More"}
                            style={{ width: 28, height: 28, padding: 0, fontSize: 15 }}
                          >
                            {isExpanded ? "−" : "+"}
                          </button>
                        </td>
                      </tr>
                      {isExpanded ? (
                        <tr style={{ background: rowStyle.background }}>
                          <td style={{ paddingTop: 0 }} />
                          <td className="colColor" style={{ padding: 0 }} />
                          <td colSpan={3} style={{ paddingTop: 0 }}>
                            <div className="expandPanel">
                              <div className="expandField expandMobileOnly">
                                <span className="small muted">Color</span>
                                <ColorPicker value={it.color as any} onChange={(c) => setColor(it.__listId, it.id, c)} />
                              </div>
                              <div className="expandField expandMobileOnly">
                                <span className="small muted">Priority</span>
                                <select value={String(it.priority ?? 3)} onChange={(e) => setPriority(it.__listId, it.id, Number(e.target.value))} style={{ padding: "4px 4px" }}>
                                  {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{p}</option>)}
                                </select>
                              </div>
                              <div className="expandField">
                                <span className="small muted">List</span>
                                <select value={it.__listId} onChange={(e) => moveRow(it.__listId, e.target.value, it.id)}>
                                  {lists.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
                                </select>
                              </div>
                              {!isTranslateRow && expandCustomFields.map((k) => {
                                const def = activeList!.fields[k];
                                return (
                                  <div key={k} className="expandField">
                                    <span className="small muted">{fieldLabel(k)}</span>
                                    {def?.type === "boolean" ? (
                                      <ToggleSwitch
                                        checked={Boolean((it as any)[k])}
                                        onChange={(v) => commit({ type: "update_item", valid: true, confidence: 1, listId: it.__listId, itemId: it.id, patch: { [k]: v } })}
                                        label={fieldLabel(k)}
                                      />
                                    ) : EDITABLE_FIELD_TYPES.has(def?.type ?? "string") ? (
                                      <div className="editableCell" onClick={() => openFieldEdit(it, k)} title="Click to edit">
                                        {String((it as any)[k] ?? "") || <span className="muted small">—</span>}
                                      </div>
                                    ) : (
                                      <span className="small">{String((it as any)[k] ?? "")}</span>
                                    )}
                                  </div>
                                );
                              })}
                              {it.__listId === TRANSLATE_LIST_ID ? (
                                <div className="expandField">
                                  <span className="small muted">Translate</span>
                                  <button className="iconbtn" onClick={() => openTranslateModal(it)} title="Open translate modal">✎</button>
                                </div>
                              ) : null}
                              <div className="expandActions">
                                <button className="iconbtn" onClick={() => openEdit(it)}>JSON</button>
                                <button className="danger" onClick={() => del(it.__listId, it.id)}>Delete</button>
                              </div>
                            </div>
                          </td>
                          <td className="expandSpacer" style={{ padding: 0 }} />
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}
                {!busy && displayRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted small">No items</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </SortableContext>
        </DndContext>
      </div>

      {!reorderMode && !undoMode ? (
        <div className="pill small" style={{ marginTop: 8, display: "inline-flex", flexWrap: "wrap", gap: 2 }}>
          <span className="muted">Sort</span>
          {sortLayers.map((l, i) => (
            <React.Fragment key={i}>
              {i > 0 ? <span className="muted">then</span> : null}
              <span>{fieldLabel(l.key)} {l.dir === "asc" ? "↑" : "↓"}</span>
            </React.Fragment>
          ))}
        </div>
      ) : null}
    </>
  );
}
