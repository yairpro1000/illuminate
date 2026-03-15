import React from "react";
import { API_BASE } from "../../api";
import { COLOR_PALETTE, STATUS_OPTIONS, STATUS_STYLE, type StatusValue } from "./constants";
import { ColorPicker, ColorSwatch, ToggleSwitch } from "./components";
import type { ListInfo } from "./types";
import type { SortLayer } from "./utils";

type UndoEntry = {
  id: string;
  label: string;
  itemCount: number;
  listIds: string[];
  createdAt: string;
};

export function ListBrowserChrome(props: {
  undoMode: boolean;
  filteredUndoLog: UndoEntry[];
  reorderMode: boolean;
  openAdd: () => void;
  listId: string;
  lists: ListInfo[];
  searchAllLists: boolean;
  items: Array<{ priority?: number | null }>;
  reorderPriority: number;
  setReorderPriority: React.Dispatch<React.SetStateAction<number>>;
  commitReorder: () => void;
  reorderIds: string[];
  cancelReorder: () => void;
  beginReorder: () => void;
  exitUndoMode: () => void;
  enterUndoMode: () => void;
  stale: { current: number; db: number } | null;
  setStale: React.Dispatch<React.SetStateAction<{ current: number; db: number } | null>>;
  loadLists: () => Promise<any>;
  loadAllRows: () => Promise<any>;
  loadItems: (listId: string) => Promise<any>;
  activeList: ListInfo | null;
  searchRows: unknown[] | null;
  filteredCount: number;
  sortedLists: ListInfo[];
  setSearchAllLists: React.Dispatch<React.SetStateAction<boolean>>;
  setListId: React.Dispatch<React.SetStateAction<string>>;
  filtersOpen: boolean;
  setFiltersOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sortLayers: SortLayer[];
  setSortDraft: React.Dispatch<React.SetStateAction<SortLayer[]>>;
  setSortModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  selectedIdsSize: number;
  selectedArchivedCount: number;
  busy: boolean;
  bulkMove: (listId: string) => void;
  bulkUpdate: (patch: { priority?: number; color?: string | null }) => void;
  bulkSetStatus: (status: StatusValue) => void;
  bulkArchiveSelected: () => void;
  bulkUnarchiveSelected: () => void;
  deleteSelected: () => void;
  filterText: string;
  setFilterText: React.Dispatch<React.SetStateAction<string>>;
  filterPriority: number | "";
  setFilterPriority: React.Dispatch<React.SetStateAction<number | "">>;
  filterColor: string | "";
  setFilterColor: React.Dispatch<React.SetStateAction<string | "">>;
  filterColorMenuRef: React.RefObject<HTMLDetailsElement>;
  topics: string[];
  filterTopic: string;
  setFilterTopic: React.Dispatch<React.SetStateAction<string>>;
  showArchived: boolean;
  setShowArchived: React.Dispatch<React.SetStateAction<boolean>>;
  unarchiveAllInScope: () => void;
  archiveAllDoneInScope: () => void;
  unarchiveCandidatesLength: number;
  archiveDoneCandidatesLength: number;
  undoAllSelected: boolean;
  setUndoSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  toggleUndoSelect: (id: string) => void;
  undoSelectedIds: Set<string>;
  executeUndo: (ids: string[], confirmed: boolean) => Promise<void>;
  undoBusy: boolean;
}) {
  const {
    undoMode,
    filteredUndoLog,
    reorderMode,
    openAdd,
    listId,
    lists,
    searchAllLists,
    items,
    reorderPriority,
    setReorderPriority,
    commitReorder,
    reorderIds,
    cancelReorder,
    beginReorder,
    exitUndoMode,
    enterUndoMode,
    stale,
    setStale,
    loadLists,
    loadAllRows,
    loadItems,
    activeList,
    searchRows,
    filteredCount,
    sortedLists,
    setSearchAllLists,
    setListId,
    filtersOpen,
    setFiltersOpen,
    sortLayers,
    setSortDraft,
    setSortModalOpen,
    selectedIdsSize,
    selectedArchivedCount,
    busy,
    bulkMove,
    bulkUpdate,
    bulkSetStatus,
    bulkArchiveSelected,
    bulkUnarchiveSelected,
    deleteSelected,
    filterText,
    setFilterText,
    filterPriority,
    setFilterPriority,
    filterColor,
    setFilterColor,
    filterColorMenuRef,
    topics,
    filterTopic,
    setFilterTopic,
    showArchived,
    setShowArchived,
    unarchiveAllInScope,
    archiveAllDoneInScope,
    unarchiveCandidatesLength,
    archiveDoneCandidatesLength,
    undoAllSelected,
    setUndoSelectedIds,
    toggleUndoSelect,
    undoSelectedIds,
    executeUndo,
    undoBusy,
  } = props;
  const [bulkArchiveAction, setBulkArchiveAction] = React.useState("");

  async function runBulkArchiveAction(action: string) {
    setBulkArchiveAction("");
    switch (action) {
      case "archive_done":
        await archiveAllDoneInScope();
        break;
      case "archive_selected":
        await bulkArchiveSelected();
        break;
      case "unarchive_selected":
        await bulkUnarchiveSelected();
        break;
      case "unarchive_all":
        await unarchiveAllInScope();
        break;
      default:
        break;
    }
  }

  return (
    <>
      <div className="topbar" style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="title">{undoMode ? "Undo History" : "Lists"}</div>
          <div className="muted small">
            {undoMode ? `${filteredUndoLog.length} action${filteredUndoLog.length !== 1 ? "s" : ""}` : "Browse • filter • sort • export"}
          </div>
        </div>
        <div className="btnrow">
          {!undoMode && (
            <button className="primary" onClick={openAdd} disabled={reorderMode || (!listId && lists.length === 0)}>
              + Add item
            </button>
          )}
          {!undoMode && reorderMode ? (
            <>
              <select
                value={String(reorderPriority)}
                onChange={(e) => setReorderPriority(Number(e.target.value))}
                style={{ width: 72 }}
              >
                {[1, 2, 3, 4, 5].map((p) => (
                  <option key={p} value={p}>P{p}</option>
                ))}
              </select>
              <button className="primary" onClick={commitReorder} disabled={reorderIds.length < 2}>
                Save order
              </button>
              <button onClick={cancelReorder}>Cancel</button>
            </>
          ) : !undoMode ? (
            <button
              onClick={beginReorder}
              disabled={searchAllLists || items.filter((it) => (it.priority ?? 3) === reorderPriority).length < 2}
              title={searchAllLists ? "Switch scope to a single list to reorder" : ""}
            >
              ↕ Reorder P{reorderPriority}
            </button>
          ) : null}
          <button
            onClick={undoMode ? exitUndoMode : enterUndoMode}
            className={undoMode ? "primary" : undefined}
          >
            {undoMode ? "Exit Undo" : "↩ Undo"}
          </button>
        </div>
      </div>

      {stale ? (
        <div className="error small" style={{ marginBottom: 10, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
          <div>
            This view is stale (yours: v{stale.current}, db: v{stale.db}). Refresh to avoid overwriting newer changes.
          </div>
          <div className="btnrow">
            <button
              className="primary"
              onClick={async () => {
                setStale(null);
                await loadLists().catch(() => {});
                if (searchAllLists) await loadAllRows();
                else await loadItems(listId);
              }}
            >
              Refresh
            </button>
          </div>
        </div>
      ) : null}

      {!reorderMode && !undoMode ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <select
            value={searchAllLists ? "__all__" : listId}
            onChange={(e) => {
              const next = e.target.value;
              if (next === "__all__") { setSearchAllLists(true); return; }
              setSearchAllLists(false);
              setListId(next);
            }}
            style={{ flex: 1, minWidth: 140 }}
          >
            <option value="__all__">All lists</option>
            {!searchAllLists && !listId ? <option value="" disabled>Choose a list…</option> : null}
            {sortedLists.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
          </select>
          {(activeList || searchAllLists) ? (
            <div className="pill small" style={{ flexShrink: 0 }}>
              <span className="muted">Items</span>
              <span>{searchAllLists ? (searchRows?.length ?? 0) : items.length}</span>
              <span className="muted">Filtered</span>
              <span>{filteredCount}</span>
            </div>
          ) : null}
          <button
            className="iconbtn"
            onClick={() => setFiltersOpen((f) => !f)}
            style={{ flexShrink: 0, borderColor: "var(--color-warning-border)", color: "var(--color-warning)", background: filtersOpen ? "var(--color-warning-bg)" : undefined }}
            title={filtersOpen ? "Hide filters" : "Show filters"}
          >
            {filtersOpen ? "− Filters" : "+ Filters"}
          </button>
          <button
            className="iconbtn"
            onClick={() => { setSortDraft([...sortLayers]); setSortModalOpen(true); }}
            style={{ flexShrink: 0, borderColor: "var(--color-accent-border)", color: "var(--color-accent)", background: sortLayers.length > 1 ? "var(--color-accent-bg)" : undefined }}
            title="Sort by"
          >
            ↕ Sort{sortLayers.length > 1 ? ` (${sortLayers.length})` : ""}
          </button>
        </div>
      ) : null}

      {!reorderMode && !undoMode && selectedIdsSize > 0 ? (
        <div className="filterBar bulkBar">
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", flexShrink: 0 }}>
            <span style={{ fontWeight: 600, color: "var(--color-danger)", fontSize: 13 }}>{selectedIdsSize} selected</span>
          </div>
          <div className="filterItem">
            <label className="small muted">Move to list</label>
            <select value="" onChange={(e) => { if (e.target.value) bulkMove(e.target.value); }} disabled={busy}>
              <option value="">Choose…</option>
              {sortedLists.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
            </select>
          </div>
          <div className="filterItem">
            <label className="small muted">Set priority</label>
            <select value="" onChange={(e) => { if (e.target.value) bulkUpdate({ priority: Number(e.target.value) }); }} disabled={busy}>
              <option value="">Choose…</option>
              {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="filterItem">
            <label className="small muted">Set status</label>
            <select value="" onChange={(e) => { if (e.target.value) bulkSetStatus(e.target.value as StatusValue); }} disabled={busy}>
              <option value="">Choose…</option>
              {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{STATUS_STYLE[s].label}</option>)}
            </select>
          </div>
          <div className="filterItem">
            <label className="small muted">Set color</label>
            <ColorPicker value={null} onChange={(c) => bulkUpdate({ color: c })} />
          </div>
          <div className="filterItem">
            <label className="small muted">Archive</label>
            <select
              value={bulkArchiveAction}
              onChange={(e) => {
                const next = e.target.value;
                setBulkArchiveAction(next);
                void runBulkArchiveAction(next);
              }}
              disabled={busy}
            >
              <option value="">Select archive action</option>
              <option value="archive_done" disabled={archiveDoneCandidatesLength === 0}>Archive done</option>
              <option value="archive_selected" disabled={selectedIdsSize === 0}>Archive selected</option>
              <option value="unarchive_selected" disabled={selectedArchivedCount === 0}>Unarchive selected</option>
              <option value="unarchive_all" disabled={unarchiveCandidatesLength === 0}>Unarchive all</option>
            </select>
          </div>
          <div className="filterItem">
            <label className="small muted">Delete</label>
            <button className="danger" onClick={deleteSelected} disabled={busy}>Delete ({selectedIdsSize})</button>
          </div>
        </div>
      ) : null}

      {!reorderMode && !undoMode && filtersOpen && selectedIdsSize === 0 ? (
        <div className="filterBar">
          <div className="filterItem" style={{ flex: 2, minWidth: 160 }}>
            <label className="small muted">Filter text</label>
            <input value={filterText} onChange={(e) => setFilterText(e.target.value)} placeholder="Search…" autoFocus />
          </div>
          <div className="filterItem">
            <label className="small muted">Priority</label>
            <select value={filterPriority === "" ? "" : String(filterPriority)} onChange={(e) => setFilterPriority(e.target.value ? Number(e.target.value) : "")}>
              <option value="">All</option>
              {[1, 2, 3, 4, 5].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div className="filterItem">
            <label className="small muted">Color</label>
            <details className="menu" style={{ width: "100%" }} ref={filterColorMenuRef}>
              <summary className="iconbtn" style={{ width: "100%", justifyContent: "space-between" }}>
                <span className="muted small">Filter</span>
                {filterColor ? <ColorSwatch color={String(filterColor)} /> : <span className="muted small">All</span>}
              </summary>
              <div className="menuPanel" style={{ minWidth: 240 }}>
                <div className="swatchGrid">
                  {COLOR_PALETTE.map((c) => (
                    <button key={c} className="swatchBtn" onClick={() => { setFilterColor(c); filterColorMenuRef.current?.removeAttribute("open"); }} title={c} aria-label={c}>
                      <ColorSwatch color={c} size={18} />
                    </button>
                  ))}
                  <button className="swatchBtn" onClick={() => { setFilterColor(""); filterColorMenuRef.current?.removeAttribute("open"); }} title="All" aria-label="All">
                    <span className="muted small">All</span>
                  </button>
                </div>
              </div>
            </details>
          </div>
          {topics.length > 0 ? (
            <div className="filterItem">
              <label className="small muted">Topic</label>
              <select value={filterTopic} onChange={(e) => setFilterTopic(e.target.value)}>
                <option value="">All</option>
                {topics.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          ) : null}
          <div className="filterItem">
            <label className="small muted">Archived</label>
            <div style={{ display: "flex", alignItems: "center", height: 42, gap: 8 }}>
              <ToggleSwitch checked={showArchived} onChange={setShowArchived} label="Show archived" />
              <span className="small muted">{showArchived ? "On" : "Off"}</span>
            </div>
          </div>
          <div className="filterItem">
            <label className="small muted">Bulk</label>
            {showArchived ? (
              <button onClick={unarchiveAllInScope} disabled={busy || unarchiveCandidatesLength === 0}>Unarchive all ({unarchiveCandidatesLength})</button>
            ) : (
              <button onClick={archiveAllDoneInScope} disabled={busy || archiveDoneCandidatesLength === 0}>Archive DONE ({archiveDoneCandidatesLength})</button>
            )}
          </div>
          {activeList ? (
            <div className="filterItem">
              <label className="small muted">Export</label>
              <div style={{ display: "flex", gap: 6 }}>
                <a href={`${API_BASE}/export/csv/${encodeURIComponent(listId)}`} className="pill small">CSV</a>
                <a href={`${API_BASE}/export/xlsx/${encodeURIComponent(listId)}`} className="pill small">XLSX</a>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {undoMode ? (
        <>
          <div style={{ overflow: "auto" }}>
            <table>
              <thead className="stickyHead">
                <tr>
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      checked={undoAllSelected}
                      onChange={() => setUndoSelectedIds(undoAllSelected ? new Set() : new Set(filteredUndoLog.map((e) => e.id)))}
                      style={{ width: 16, height: 16 }}
                    />
                  </th>
                  <th>action</th>
                  <th>list(s)</th>
                  <th>items</th>
                  <th>time</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredUndoLog.map((entry) => {
                  const listNames = entry.listIds
                    .map((lid) => lists.find((l) => l.id === lid)?.title ?? lid)
                    .join(", ");
                  return (
                    <tr key={entry.id}>
                      <td style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          checked={undoSelectedIds.has(entry.id)}
                          onChange={() => toggleUndoSelect(entry.id)}
                          style={{ width: 16, height: 16 }}
                        />
                      </td>
                      <td style={{ minWidth: 280 }}>{entry.label}</td>
                      <td className="small muted" style={{ minWidth: 120 }}>{listNames}</td>
                      <td className="small muted" style={{ minWidth: 60 }}>{entry.itemCount}</td>
                      <td className="small muted" style={{ minWidth: 150 }}>
                        {new Date(entry.createdAt).toLocaleString()}
                      </td>
                      <td>
                        <button
                          className="iconbtn"
                          onClick={() => executeUndo([entry.id], false)}
                          disabled={undoBusy}
                          title="Undo this action"
                        >
                          ↩
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {filteredUndoLog.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted small">No undo history</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
            <button
              className="primary"
              onClick={() => executeUndo(Array.from(undoSelectedIds), false)}
              disabled={undoBusy || undoSelectedIds.size === 0}
            >
              Undo selected ({undoSelectedIds.size})
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}
