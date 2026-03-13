import React from "react";
import { api } from "../api";
import type { FieldDef, ListItem } from "@shared/model";
import { MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import {
  DEFAULT_SPEECH_LANG_VALUE,
  SPEECH_LANG_OPTIONS,
  SPEECH_LANG_STORAGE_KEY,
  getSpeechRecognition,
  resolveSpeechLang,
  type SpeechRecognitionLike,
} from "./speech";
import { type StatusValue } from "./listBrowser/constants";
import { useDismissibleDetails } from "./listBrowser/components";
import { useListData } from "./listBrowser/useListData";
import type { ItemRow, ListInfo } from "./listBrowser/types";
import { buildDisplayRows, buildTopics, buildVisibleRows, findItemUpdatedAt } from "./listBrowser/derived";
import { useBulkActions } from "./listBrowser/useBulkActions";
import { useTranslateFlow } from "./listBrowser/useTranslateFlow";
import { useUndoFlow } from "./listBrowser/useUndoFlow";
import { ListBrowserChrome } from "./listBrowser/ListBrowserChrome";
import { ListBrowserOverlays } from "./listBrowser/ListBrowserOverlays";
import { ListBrowserTable } from "./listBrowser/ListBrowserTable";
import {
  isTranslateLike,
  TRANSLATE_LIST_ID,
  TRANSLATE_LANG_VALUES,
  translateLangFlag,
  translateLangLabel,
  type TranslateLang,
} from "./translate";

import { type SortLayer, fieldLabel, moveArrayItem } from "./listBrowser/utils";

export function ListBrowser(props: {
  refreshSignal: number;
  translateIntent?: string | null;
  onTranslateIntentHandled?: () => void;
}) {
  const SR = getSpeechRecognition();
  const [filterText, setFilterText] = React.useState("");
  const [searchAllLists, setSearchAllLists] = React.useState(false);
  const [filterPriority, setFilterPriority] = React.useState<number | "">("");
  const [filterColor, setFilterColor] = React.useState<string | "">("");
  const [filterTopic, setFilterTopic] = React.useState<string>("");
  const [showArchived, setShowArchived] = React.useState(false);

  const filterColorMenuRef = React.useRef<HTMLDetailsElement | null>(null);
  useDismissibleDetails(filterColorMenuRef);

  const [sortLayers, setSortLayers] = React.useState<SortLayer[]>([{ key: "createdAt", dir: "desc" }]);
  const [sortModalOpen, setSortModalOpen] = React.useState(false);
  const [sortDraft, setSortDraft] = React.useState<SortLayer[]>([]);
  const [reorderPriority, setReorderPriority] = React.useState<number>(3);
  const [reorderMode, setReorderMode] = React.useState(false);
  const [reorderIds, setReorderIds] = React.useState<string[]>([]);
  const reorderBackupRef = React.useRef<{
    filterText: string;
    filterPriority: number | "";
    filterColor: string | "";
    filterTopic: string;
    showArchived: boolean;
    sortLayers: SortLayer[];
    searchAllLists: boolean;
  } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  // Full JSON edit modal (accessible from expanded panel)
  const [editOpen, setEditOpen] = React.useState(false);
  const [editRow, setEditRow] = React.useState<ItemRow | null>(null);
  const [editDraft, setEditDraft] = React.useState("");
  const [editOriginalDraft, setEditOriginalDraft] = React.useState("");
  const [editErr, setEditErr] = React.useState<string | null>(null);
  // Single-field edit modal
  const [fieldEditOpen, setFieldEditOpen] = React.useState(false);
  const [fieldEditRow, setFieldEditRow] = React.useState<ItemRow | null>(null);
  const [fieldEditName, setFieldEditName] = React.useState<string>("");
  const [fieldEditValue, setFieldEditValue] = React.useState<string>("");
  const [fieldEditErr, setFieldEditErr] = React.useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  // Expanded accordion rows
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());
  // dnd sensors: mouse + touch with long-press activation for mobile
  const mouseSensor = useSensor(MouseSensor);
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } });
  const sensors = useSensors(mouseSensor, touchSensor);
  const [addOpen, setAddOpen] = React.useState(false);
  const [addListId, setAddListId] = React.useState<string>("");
  const [addFields, setAddFields] = React.useState<Record<string, unknown>>({});
  const [addStatus, setAddStatus] = React.useState<StatusValue>("todo");
  const [addColor, setAddColor] = React.useState<string | null>(null);
  const [addErr, setAddErr] = React.useState<string | null>(null);
  const [addTranslateFrom, setAddTranslateFrom] = React.useState<TranslateLang | "">("");
  const [addTranslateTo, setAddTranslateTo] = React.useState<TranslateLang | "">("");
  const [addListening, setAddListening] = React.useState(false);
  const addListeningRef = React.useRef(false);
  const lastAddMicClickRef = React.useRef<number>(0);
  const addRecRef = React.useRef<SpeechRecognitionLike | null>(null);
  const addMicBaseRef = React.useRef<string>("");
  const addMicFinalRef = React.useRef<string>("");
  const addMicRestartTimerRef = React.useRef<number | null>(null);
  const addMicSessionRef = React.useRef(0);
  const [speechLang, setSpeechLang] = React.useState<string>(() => {
    try {
      return window.localStorage.getItem(SPEECH_LANG_STORAGE_KEY) ?? DEFAULT_SPEECH_LANG_VALUE;
    } catch {
      return DEFAULT_SPEECH_LANG_VALUE;
    }
  });

  React.useEffect(() => {
    try {
      window.localStorage.setItem(SPEECH_LANG_STORAGE_KEY, speechLang);
    } catch {
      // ignore
    }
  }, [speechLang]);

  const {
    lists,
    listId,
    setListId,
    items,
    searchRows,
    busy,
    setBusy,
    err: dataErr,
    stale,
    setStale,
    sortedLists,
    activeList,
    loadLists,
    loadItems,
    loadAllRows,
  } = useListData({ refreshSignal: props.refreshSignal, searchAllLists });

  React.useEffect(() => {
    setErr(dataErr);
  }, [dataErr]);

  const {
    undoMode,
    undoLog,
    undoSelectedIds,
    setUndoSelectedIds,
    undoToast,
    undoConfirm,
    setUndoConfirm,
    undoBusy,
    showUndoToast,
    dismissUndoToast,
    loadUndoLog,
    enterUndoMode,
    exitUndoMode,
    toggleUndoSelect,
    executeUndo,
  } = useUndoFlow({
    loadLists,
    loadAllRows,
    loadItems,
    listId,
    searchAllLists,
    setErr,
    setStale,
  });

  React.useEffect(() => {
    if (!addListening) return;
    function onDocClick(ev: MouseEvent) {
      const el = ev.target as HTMLElement | null;
      const btn = el?.closest?.("button");
      if (!btn) return;
      if (btn.getAttribute("data-mic") === "add") return;
      stopAddMic();
    }
    document.addEventListener("click", onDocClick, true);
    return () => document.removeEventListener("click", onDocClick, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addListening]);

  const visibleRows = buildVisibleRows({
    searchAllLists,
    searchRows,
    items,
    listId,
    filterText,
    filterPriority,
    filterColor,
    filterTopic,
    showArchived,
  });
  const { filtered, displayRows } = buildDisplayRows({
    visibleRows,
    sortLayers,
    reorderMode,
    reorderIds,
  });
  const topics = buildTopics(visibleRows);
  const getItemUpdatedAt = (targetListId: string, itemId: string) => findItemUpdatedAt({
    targetListId,
    itemId,
    searchAllLists,
    searchRows,
    listId,
    items,
  });
  const {
    selectedIds,
    setSelectedIds,
    toggleSelect,
    toggleSelectAll,
    deleteSelected,
    bulkUpdate,
    bulkMove,
    bulkSetStatus,
    selectedArchivedCount,
    bulkArchiveSelected,
    bulkUnarchiveSelected,
  } = useBulkActions({
    displayRows,
    searchAllLists,
    listId,
    loadAllRows,
    loadItems,
    setBusy,
    setErr,
    commit,
    getItemUpdatedAt,
    ensureStatusField,
    ensureArchivedField,
  });

  function toggleSort(key: string) {
    if (reorderMode) return;
    setSortLayers((prev) => {
      if (prev[0]?.key === key) {
        return [{ key, dir: prev[0].dir === "asc" ? "desc" : "asc" }, ...prev.slice(1)];
      }
      return [{ key, dir: "asc" }, ...prev.filter((l) => l.key !== key)];
    });
  }

  async function commit(action: any, opts?: { refresh?: boolean; expectedItemUpdatedAt?: string; undoLabel?: string }) {
    let res: { ok: boolean; result?: any; undoId?: string } | undefined;
    try {
      res = await api<{ ok: boolean; result?: any; undoId?: string }>("/commit", {
        method: "POST",
        body: JSON.stringify({
          action,
          ...(opts?.expectedItemUpdatedAt ? { expected: { itemUpdatedAt: opts.expectedItemUpdatedAt } } : {}),
        }),
      });
    } catch (e: any) {
      const raw = String(e?.message ?? e);
      let msg = raw;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          msg = "Conflict: data changed elsewhere. Refresh and try again.";
          const currentRevision = typeof (parsed as any).currentRevision === "number" ? (parsed as any).currentRevision : null;
          if (currentRevision !== null && activeList?.meta?.revision !== undefined) {
            setStale({ current: activeList.meta.revision, db: currentRevision });
          }
        }
      } catch {
        if (raw === "conflict") msg = "Conflict: data changed elsewhere. Refresh and try again.";
      }
      setErr(msg);
      throw e;
    }

    if (res?.undoId && opts?.undoLabel) showUndoToast(res.undoId, opts.undoLabel);
    await loadLists().catch(() => {});
    const refresh = opts?.refresh !== false;
    if (refresh) {
      if (searchAllLists) await loadAllRows();
      else await loadItems(listId);
    }
    return res?.result;
  }

  const {
    translateOpen,
    translateRow,
    translateInitial,
    openTranslateModal,
    closeTranslateModal,
    ensureTranslateListReady,
    llmTranslate,
    llmRefine,
    handleTranslateIntentInput,
    saveTranslation,
    deleteTranslation,
  } = useTranslateFlow({
    lists,
    commit,
    setBusy,
    setErr,
    setSearchAllLists,
    setListId,
    translateIntent: props.translateIntent,
    onTranslateIntentHandled: props.onTranslateIntentHandled,
  });

  async function ensureStatusField(targetListId: string) {
    const def = lists.find((l) => l.id === targetListId);
    if (!def) return;
    if (def.fields.status) return;
    await commit({
      type: "add_fields",
      valid: true,
      confidence: 1,
      listId: targetListId,
      fieldsToAdd: [{ name: "status", type: "string", default: "todo", description: "Workflow status" }],
    });
  }

  async function ensureArchivedField(targetListId: string) {
    const def = lists.find((l) => l.id === targetListId);
    if (!def) return;
    if (def.fields.archivedAt) return;
    await commit(
      {
      type: "add_fields",
      valid: true,
      confidence: 1,
      listId: targetListId,
      fieldsToAdd: [
        {
          name: "archivedAt",
          type: "date",
          default: null,
          nullable: true,
          description: "Archived timestamp (hidden by default)",
        },
      ],
      },
      { refresh: false },
    );
  }

  async function ensureStatusFieldIfUsed(targetListId: string) {
    if (addStatus !== "todo") await ensureStatusField(targetListId);
  }

  async function setPriority(targetListId: string, itemId: string, priority: number) {
    await commit(
      { type: "update_item", valid: true, confidence: 1, listId: targetListId, itemId, patch: { priority } },
      { expectedItemUpdatedAt: getItemUpdatedAt(targetListId, itemId) },
    );
  }

  async function setColor(targetListId: string, itemId: string, color: string | null) {
    await commit(
      { type: "update_item", valid: true, confidence: 1, listId: targetListId, itemId, patch: { color } },
      { expectedItemUpdatedAt: getItemUpdatedAt(targetListId, itemId) },
    );
  }

  async function setStatusAny(targetListId: string, itemId: string, status: StatusValue) {
    await ensureStatusField(targetListId);
    await commit(
      { type: "update_item", valid: true, confidence: 1, listId: targetListId, itemId, patch: { status } },
      { expectedItemUpdatedAt: getItemUpdatedAt(targetListId, itemId) },
    );
  }

  async function archiveItem(targetListId: string, itemId: string) {
    await ensureArchivedField(targetListId);
    await commit(
      {
      type: "update_item",
      valid: true,
      confidence: 1,
      listId: targetListId,
      itemId,
      patch: { archivedAt: new Date().toISOString() },
      },
      { refresh: true, expectedItemUpdatedAt: getItemUpdatedAt(targetListId, itemId), undoLabel: "Archived item" },
    );
  }

  async function unarchiveItem(targetListId: string, itemId: string) {
    await ensureArchivedField(targetListId);
    await commit(
      { type: "update_item", valid: true, confidence: 1, listId: targetListId, itemId, patch: { archivedAt: null } },
      { expectedItemUpdatedAt: getItemUpdatedAt(targetListId, itemId) },
    );
  }

  async function del(targetListId: string, itemId: string) {
    await commit(
      { type: "delete_item", valid: true, confidence: 1, listId: targetListId, itemId },
      { expectedItemUpdatedAt: getItemUpdatedAt(targetListId, itemId), undoLabel: "Deleted item" },
    );
  }

  // Accordion expand
  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Single-field edit modal
  function openFieldEdit(row: ItemRow, fieldName: string) {
    setFieldEditRow(row);
    setFieldEditName(fieldName);
    setFieldEditValue(String((row as any)[fieldName] ?? ""));
    setFieldEditErr(null);
    setFieldEditOpen(true);
  }

  async function confirmFieldEdit() {
    if (!fieldEditRow || !fieldEditName) return;
    setFieldEditErr(null);
    try {
      const list = lists.find((l) => l.id === fieldEditRow.__listId);
      const fieldDef = list?.fields[fieldEditName];
      let value: unknown = fieldEditValue;
      if (fieldDef?.type === "int") value = parseInt(fieldEditValue, 10);
      else if (fieldDef?.type === "float") value = parseFloat(fieldEditValue);
      else if (fieldDef?.type === "boolean") value = fieldEditValue === "true";
      else if (fieldDef?.type === "json") {
        try { value = JSON.parse(fieldEditValue); } catch (e: any) {
          setFieldEditErr(`Invalid JSON: ${String(e?.message ?? e)}`);
          return;
        }
      }
      await commit(
        { type: "update_item", valid: true, confidence: 1, listId: fieldEditRow.__listId, itemId: fieldEditRow.id, patch: { [fieldEditName]: value } },
        { expectedItemUpdatedAt: (fieldEditRow as any).updatedAt, undoLabel: "Updated item" },
      );
      setFieldEditOpen(false);
      setFieldEditRow(null);
    } catch (e: any) {
      setFieldEditErr(String(e?.message ?? e));
    }
  }

  async function saveReorder(orderedIds: string[]) {
    await api(`/lists/${encodeURIComponent(listId)}/reorder`, {
      method: "POST",
      body: JSON.stringify({ priority: reorderPriority, orderedIds, expectedRevision: activeList?.meta?.revision ?? 0 }),
    });
    await loadLists().catch(() => {});
    await loadItems(listId);
  }

  function beginReorder() {
    if (searchAllLists) {
      setErr("Reorder is only available when scoped to a single list.");
      return;
    }
    setErr(null);
    reorderBackupRef.current = {
      filterText,
      filterPriority,
      filterColor,
      filterTopic,
      showArchived,
      sortLayers,
      searchAllLists,
    };
    setReorderMode(true);
    setFilterPriority(reorderPriority);
    setShowArchived(false);
    setSortLayers([{ key: "order", dir: "asc" }]);
    const ids = items
      .filter((it) => (it.priority ?? 3) === reorderPriority)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((it) => it.id);
    setReorderIds(ids);
  }

  function cancelReorder() {
    setReorderMode(false);
    setReorderIds([]);
    const b = reorderBackupRef.current;
    reorderBackupRef.current = null;
    if (!b) return;
    setFilterText(b.filterText);
    setFilterPriority(b.filterPriority);
    setFilterColor(b.filterColor);
    setFilterTopic(b.filterTopic);
    setShowArchived(b.showArchived);
    setSortLayers(b.sortLayers);
    setSearchAllLists(b.searchAllLists);
  }

  async function commitReorder() {
    try {
      await saveReorder(reorderIds);
    } catch (e: any) {
      const raw = String(e?.message ?? e);
      let msg = raw;
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") msg = "Conflict: list changed elsewhere. Refresh and try again.";
      } catch {
        if (raw === "conflict") msg = "Conflict: list changed elsewhere. Refresh and try again.";
      }
      setErr(msg);
    } finally {
      cancelReorder();
    }
  }

  const archiveDoneCandidates = displayRows.filter((it) => {
    const status = String((it as any).status ?? "");
    const archivedAt = (it as any).archivedAt;
    const isArchived = typeof archivedAt === "string" && String(archivedAt).trim();
    return status === "done" && !isArchived;
  });

  const unarchiveCandidates = displayRows.filter((it) => {
    const archivedAt = (it as any).archivedAt;
    return (typeof archivedAt === "string" && String(archivedAt).trim()) || archivedAt === true;
  });

  async function archiveAllDoneInScope() {
    if (reorderMode) return;
    if (archiveDoneCandidates.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const listIds = Array.from(new Set(archiveDoneCandidates.map((it) => it.__listId)));
      for (const lid of listIds) await ensureArchivedField(lid);
      const now = new Date().toISOString();
      const label = `Archived ${archiveDoneCandidates.length} done item${archiveDoneCandidates.length !== 1 ? "s" : ""}`;
      await commit(
        {
          type: "batch",
          valid: true,
          confidence: 1,
          label,
          actions: archiveDoneCandidates.map((it) => ({
            type: "update_item",
            listId: it.__listId,
            itemId: it.id,
            patch: { archivedAt: now },
          })),
        },
        { undoLabel: label },
      );
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function unarchiveAllInScope() {
    if (reorderMode) return;
    if (unarchiveCandidates.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const listIds = Array.from(new Set(unarchiveCandidates.map((it) => it.__listId)));
      for (const lid of listIds) await ensureArchivedField(lid);
      const label = `Unarchived ${unarchiveCandidates.length} item${unarchiveCandidates.length !== 1 ? "s" : ""}`;
      await commit(
        {
          type: "batch",
          valid: true,
          confidence: 1,
          label,
          actions: unarchiveCandidates.map((it) => ({
            type: "update_item",
            listId: it.__listId,
            itemId: it.id,
            patch: { archivedAt: null },
          })),
        },
        { undoLabel: label },
      );
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  function onDragEnd(ev: any) {
    const { active, over } = ev;
    if (!over || active.id === over.id) return;
    setReorderIds((prev) => {
      const from = prev.indexOf(active.id);
      const to = prev.indexOf(over.id);
      if (from < 0 || to < 0) return prev;
      return moveArrayItem(prev, from, to);
    });
  }

  function openEdit(row: ItemRow) {
    setEditErr(null);
    setEditRow(row);
    const { id: _id, createdAt: _createdAt, __listId: _listId, ...rest } = row as any;
    const draft = JSON.stringify(rest, null, 2);
    setEditDraft(draft);
    setEditOriginalDraft(draft);
    setEditOpen(true);
  }

  async function confirmEdit() {
    if (!editRow) return;
    setEditErr(null);
    try {
      const parsed = JSON.parse(editDraft);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Edit JSON must be an object of fields to set.");
      }
      await commit(
        {
          type: "update_item",
          valid: true,
          confidence: 1,
          listId: editRow.__listId,
          itemId: editRow.id,
          patch: parsed,
        },
        { expectedItemUpdatedAt: (editRow as any).updatedAt, undoLabel: "Updated item" },
      );
      setEditOpen(false);
      setEditRow(null);
      setEditDraft("");
    } catch (e: any) {
      setEditErr(String(e?.message ?? e));
    }
  }

  async function moveRow(fromListId: string, toListId: string, itemId: string) {
    if (fromListId === toListId) return;
    await commit({ type: "move_item", valid: true, confidence: 1, fromListId, toListId, itemId }, { undoLabel: "Moved item" });
  }

  function openAdd() {
    setAddErr(null);
    setAddOpen(true);
    setAddListId(listId || lists.find((l) => l.id === "app")?.id || lists[0]?.id || "");
    setAddFields({ text: "" });
    setAddStatus("todo");
    setAddColor(null);
  }

  function createAndStartAddRec(sessionId: number) {
    if (!SR) return;
    if (sessionId !== addMicSessionRef.current) return;

    const prev = addRecRef.current;
    addRecRef.current = null;
    if (prev) {
      prev.onend = null;
      prev.onresult = null;
      prev.onerror = null;
      try {
        prev.stop();
      } catch {
        // ignore
      }
    }

    const rec = new SR();
    rec.lang = resolveSpeechLang(speechLang);
    rec.continuous = false; // manual restart prevents browser auto-restart overlap
    rec.interimResults = true;
    rec.onresult = (ev) => {
      if (sessionId !== addMicSessionRef.current) return;
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        const chunk = String(res?.[0]?.transcript ?? "");
        if (!chunk) continue;
        if (res.isFinal) addMicFinalRef.current += chunk;
        else interim += chunk;
      }
      const base = addMicBaseRef.current;
      const finalPart = addMicFinalRef.current.trim();
      const interimPart = interim.trim();
      const merged = [base, finalPart, interimPart].filter(Boolean).join(" ").replaceAll(/\s+/g, " ").trim();
      setAddField("text", merged);
    };
    rec.onerror = (ev) => {
      if (sessionId !== addMicSessionRef.current) return;
      const code = String((ev as any)?.error ?? "unknown");
      // Many browsers emit "no-speech" when you pause; keep the mic "on" by restarting.
      if (addListeningRef.current && ["no-speech", "audio-capture", "network"].includes(code)) return;
      setAddErr(`Speech error: ${code}`);
      stopAddMic();
    };
    rec.onend = () => {
      if (sessionId !== addMicSessionRef.current) return;
      // Auto-restart to tolerate silence gaps while the mic toggle is "on".
      if (!addListeningRef.current) return;
      if (addMicRestartTimerRef.current) window.clearTimeout(addMicRestartTimerRef.current);
      addMicRestartTimerRef.current = window.setTimeout(() => {
        if (sessionId !== addMicSessionRef.current) return;
        if (addListeningRef.current) createAndStartAddRec(sessionId);
      }, 250);
    };

    addRecRef.current = rec;
    try {
      rec.start();
    } catch (e: any) {
      setAddErr(String(e?.message ?? e));
      stopAddMic();
    }
  }

  function stopAddMic() {
    addListeningRef.current = false;
    addMicSessionRef.current += 1; // invalidate any in-flight callbacks/timers
    if (addMicRestartTimerRef.current) {
      window.clearTimeout(addMicRestartTimerRef.current);
      addMicRestartTimerRef.current = null;
    }
    const prev = addRecRef.current;
    addRecRef.current = null;
    if (prev) {
      prev.onend = null;
      prev.onresult = null;
      prev.onerror = null;
      try {
        prev.stop();
      } catch {
        // ignore
      }
    }
    setAddListening(false);
  }

  function startAddMic() {
    if (!SR) return;
    if (addListeningRef.current) return;
    setAddErr(null);

    // Keep what's already in the field and append dictation to it.
    addMicBaseRef.current = String(addFields.text ?? "").trim();
    addMicFinalRef.current = "";

    addListeningRef.current = true;
    setAddListening(true);
    const sessionId = (addMicSessionRef.current += 1);
    createAndStartAddRec(sessionId);
  }

  function setAddField(name: string, value: unknown) {
    setAddFields((prev) => ({ ...prev, [name]: value }));
  }

  function activeAddList() {
    const id = addListId || listId;
    return lists.find((l) => l.id === id) ?? null;
  }

  function requiredFieldNamesForList(l: ListInfo | null) {
    if (!l) return [];
    return Object.entries(l.fields)
      .filter(([name]) => !["order", "archivedAt", "unarchivedAt"].includes(name))
      .filter(([name, def]) => {
        if (name === "color") return false;
        if (name === "status") return false;
        if (Object.prototype.hasOwnProperty.call(def, "default")) return false;
        if (def.nullable) return false;
        return true;
      })
      .map(([name]) => name);
  }

  function validateAddForm() {
    const l = activeAddList();
    if (!l) return "No list selected.";
    const text = String(addFields.text ?? "");
    // In translate mode (translate list selected, or text looks like a translate request),
    // only the text field is required — translate flow bypasses all other fields.
    if (l.id === TRANSLATE_LIST_ID || isTranslateLike(text)) {
      if (!text.trim()) return "Text is required.";
      return null;
    }
    const required = requiredFieldNamesForList(l);
    for (const name of required) {
      const v = addFields[name];
      if (typeof v === "string") {
        if (!v.trim()) return `Missing required field: ${name}`;
      } else if (v === undefined || v === null) {
        return `Missing required field: ${name}`;
      }
    }
    if (!text.trim()) return "Text is required.";
    return null;
  }

  async function submitAdd() {
    setAddErr(null);
    const l = activeAddList();
    if (!l) return;
    const vErr = validateAddForm();
    if (vErr) {
      setAddErr(vErr);
      return;
    }

    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(addFields)) {
      if (v === undefined) continue;
      if (typeof v === "string" && v.trim() === "" && k !== "text") continue;
      const def = l.fields[k];
      if (def?.type === "json" && typeof v === "string" && v.trim()) {
        try {
          fields[k] = JSON.parse(v);
        } catch (e: any) {
          setAddErr(`Invalid JSON for "${k}": ${String(e?.message ?? e)}`);
          return;
        }
      } else {
        fields[k] = v;
      }
    }
    if (addColor !== null) fields.color = addColor;
    if (addStatus !== "todo") fields.status = addStatus;

    try {
      const rawText = String(fields.text ?? "");
      const isTranslateMode = l.id === TRANSLATE_LIST_ID || isTranslateLike(rawText);
      if (isTranslateMode) {
        setBusy(true);
        try {
          await ensureTranslateListReady();
          const translation = await llmTranslate(rawText);
          const originExpression = String(translation.originExpression ?? "").trim() || rawText.trim();
          const result = await commit(
            {
              type: "append_item",
              valid: true,
              confidence: 1,
              listId: TRANSLATE_LIST_ID,
              fields: {
                ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
                ...(fields.color !== undefined ? { color: fields.color } : {}),
                ...(fields.status !== undefined ? { status: fields.status } : {}),
                text: originExpression,
                originLanguage: translation.originLanguage,
                originExpression,
                destinationLanguage: translation.destinationLanguage,
                possibleTranslations: translation.possibleTranslations,
                examplesOrigin: translation.examplesOrigin,
                examplesDestination: translation.examplesDestination,
                comments: translation.comments,
              },
            },
            { refresh: true },
          );
          setSearchAllLists(false);
          setListId(TRANSLATE_LIST_ID);
          const row = result?.item ? ({ ...(result.item as any), __listId: TRANSLATE_LIST_ID } as ItemRow) : null;
          if (row) openTranslateModal(row, translation);
        } finally {
          setBusy(false);
        }
      } else {
        await ensureStatusFieldIfUsed(l.id);
        await commit({ type: "append_item", valid: true, confidence: 1, listId: l.id, fields });
      }
      setAddOpen(false);
      setAddListId("");
      setAddFields({});
      setAddColor(null);
      setAddStatus("todo");
    } catch (e: any) {
      setAddErr(String(e?.message ?? e));
    }
  }

  async function submitAddTranslate() {
    const expr = String(addFields.text ?? "").trim();
    if (!expr) return;
    let input = expr;
    if (addTranslateFrom && addTranslateTo) {
      input = `translate "${expr}" from ${translateLangLabel(addTranslateFrom)} to ${translateLangLabel(addTranslateTo)}`;
    } else if (addTranslateFrom) {
      input = `translate "${expr}" from ${translateLangLabel(addTranslateFrom)}`;
    } else if (addTranslateTo) {
      input = `translate "${expr}" to ${translateLangLabel(addTranslateTo)}`;
    }
    setAddOpen(false);
    setAddErr(null);
    await handleTranslateIntentInput(input, {
      priority: Number(addFields.priority ?? 3),
      color: addColor,
      status: addStatus,
    });
  }

  function renderAddFieldInput(list: ListInfo, fieldName: string, def: FieldDef) {
    const required =
      !Object.prototype.hasOwnProperty.call(def, "default") && !def.nullable && fieldName !== "order" && fieldName !== "color";
    const label = (
      <span>
        {fieldLabel(fieldName)} {required ? <span className="muted small">*</span> : null}
      </span>
    );

    const val = addFields[fieldName];
    switch (def.type) {
      case "string":
        return (
          <div key={fieldName} className="formCol">
            <label className="small muted">{label}</label>
            <input value={typeof val === "string" ? val : String(val ?? "")} onChange={(e) => setAddField(fieldName, e.target.value)} />
          </div>
        );
      case "int":
      case "float":
        return (
          <div key={fieldName} className="formCol">
            <label className="small muted">{label}</label>
            <input
              type="number"
              value={val === undefined || val === null || val === "" ? "" : String(val)}
              step={def.type === "float" ? "any" : "1"}
              onChange={(e) => setAddField(fieldName, e.target.value === "" ? undefined : Number(e.target.value))}
            />
          </div>
        );
      case "boolean":
        return (
          <div key={fieldName} className="formCol">
            <label className="small muted">{label}</label>
            <div className="row" style={{ alignItems: "center", gap: 10 }}>
              <input
                type="checkbox"
                checked={Boolean(val)}
                onChange={(e) => setAddField(fieldName, e.target.checked)}
                style={{ width: 18, height: 18 }}
              />
              <span className="small muted">{Boolean(val) ? "True" : "False"}</span>
            </div>
          </div>
        );
      case "date":
        return (
          <div key={fieldName} className="formCol">
            <label className="small muted">{label}</label>
            <input
              type="date"
              value={typeof val === "string" ? val.slice(0, 10) : ""}
              onChange={(e) => setAddField(fieldName, e.target.value)}
            />
          </div>
        );
      case "time":
        return (
          <div key={fieldName} className="formCol">
            <label className="small muted">{label}</label>
            <input
              type="time"
              value={typeof val === "string" ? val : ""}
              onChange={(e) => setAddField(fieldName, e.target.value)}
            />
          </div>
        );
      case "json":
        return (
          <div key={fieldName} className="formCol">
            <label className="small muted">{label}</label>
            <textarea
              value={typeof val === "string" ? val : val ? JSON.stringify(val, null, 2) : ""}
              onChange={(e) => setAddField(fieldName, e.target.value)}
              placeholder='{"any":"json"}'
              style={{ minHeight: 80 }}
            />
          </div>
        );
      default:
        return null;
    }
  }

  React.useEffect(() => {
    if (!addOpen) {
      stopAddMic();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addOpen]);

  const expandCustomFields = activeList
    ? Object.keys(activeList.fields).filter(
        (k) => !["text", "priority", "color", "order", "status", "archivedAt", "unarchivedAt"].includes(k) &&
               activeList.fields[k]?.ui?.showInPreview !== false,
      )
    : [];

  const filteredUndoLog = undoLog.filter((entry) => {
    if (filterText && !entry.label.toLowerCase().includes(filterText.toLowerCase())) return false;
    if (!searchAllLists && listId && !entry.listIds.includes(listId)) return false;
    return true;
  });

  const undoAllSelected = undoSelectedIds.size === filteredUndoLog.length && filteredUndoLog.length > 0;
  const isAddTranslateMode = activeAddList()?.id === TRANSLATE_LIST_ID;

  return (
    <div className="card" style={undoMode ? { borderColor: "#1a90d4", boxShadow: "0 0 0 2px rgba(26,144,212,0.25)" } : undefined}>
      <ListBrowserChrome
        undoMode={undoMode}
        filteredUndoLog={filteredUndoLog}
        reorderMode={reorderMode}
        openAdd={openAdd}
        listId={listId}
        lists={lists}
        searchAllLists={searchAllLists}
        items={items}
        reorderPriority={reorderPriority}
        setReorderPriority={setReorderPriority}
        commitReorder={commitReorder}
        reorderIds={reorderIds}
        cancelReorder={cancelReorder}
        beginReorder={beginReorder}
        exitUndoMode={exitUndoMode}
        enterUndoMode={enterUndoMode}
        stale={stale}
        setStale={setStale}
        loadLists={loadLists}
        loadAllRows={loadAllRows}
        loadItems={loadItems}
        activeList={activeList}
        searchRows={searchRows}
        filteredCount={filtered.length}
        sortedLists={sortedLists}
        setSearchAllLists={setSearchAllLists}
        setListId={setListId}
        filtersOpen={filtersOpen}
        setFiltersOpen={setFiltersOpen}
        sortLayers={sortLayers}
        setSortDraft={setSortDraft}
        setSortModalOpen={setSortModalOpen}
        selectedIdsSize={selectedIds.size}
        busy={busy}
        bulkMove={bulkMove}
        bulkUpdate={bulkUpdate}
        bulkSetStatus={bulkSetStatus}
        selectedArchivedCount={selectedArchivedCount}
        bulkArchiveSelected={bulkArchiveSelected}
        bulkUnarchiveSelected={bulkUnarchiveSelected}
        deleteSelected={deleteSelected}
        filterText={filterText}
        setFilterText={setFilterText}
        filterPriority={filterPriority}
        setFilterPriority={setFilterPriority}
        filterColor={filterColor}
        setFilterColor={setFilterColor}
        filterColorMenuRef={filterColorMenuRef}
        topics={topics}
        filterTopic={filterTopic}
        setFilterTopic={setFilterTopic}
        showArchived={showArchived}
        setShowArchived={setShowArchived}
        unarchiveAllInScope={unarchiveAllInScope}
        archiveAllDoneInScope={archiveAllDoneInScope}
        unarchiveCandidatesLength={unarchiveCandidates.length}
        archiveDoneCandidatesLength={archiveDoneCandidates.length}
        undoAllSelected={undoAllSelected}
        setUndoSelectedIds={setUndoSelectedIds}
        toggleUndoSelect={toggleUndoSelect}
        undoSelectedIds={undoSelectedIds}
        executeUndo={executeUndo}
        undoBusy={undoBusy}
      />

      <ListBrowserTable
        undoMode={undoMode}
        reorderMode={reorderMode}
        sensors={sensors}
        onDragEnd={onDragEnd}
        reorderIds={reorderIds}
        displayRows={displayRows}
        selectedIds={selectedIds}
        toggleSelect={toggleSelect}
        toggleSelectAll={toggleSelectAll}
        busy={busy}
        searchAllLists={searchAllLists}
        listId={listId}
        reorderPriority={reorderPriority}
        expandedIds={expandedIds}
        setColor={setColor}
        openTranslateModal={openTranslateModal}
        openFieldEdit={openFieldEdit}
        setStatusAny={setStatusAny}
        archiveItem={archiveItem}
        unarchiveItem={unarchiveItem}
        setPriority={setPriority}
        toggleExpand={toggleExpand}
        moveRow={moveRow}
        lists={lists}
        activeList={activeList}
        expandCustomFields={expandCustomFields}
        commit={commit}
        del={del}
        openEdit={openEdit}
        sortLayers={sortLayers}
        toggleSort={toggleSort}
      />

      <ListBrowserOverlays
        sortModalOpen={sortModalOpen}
        setSortModalOpen={setSortModalOpen}
        searchAllLists={searchAllLists}
        activeList={activeList}
        sortDraft={sortDraft}
        setSortDraft={setSortDraft}
        setSortLayers={setSortLayers}
        fieldLabel={fieldLabel}
        addOpen={addOpen}
        setAddOpen={setAddOpen}
        addErr={addErr}
        setAddErr={setAddErr}
        lists={lists}
        addListId={addListId}
        setAddListId={setAddListId}
        addFields={addFields}
        setAddField={setAddField}
        addStatus={addStatus}
        setAddStatus={setAddStatus}
        addColor={addColor}
        setAddColor={setAddColor}
        isAddTranslateMode={isAddTranslateMode}
        addTranslateFrom={addTranslateFrom}
        setAddTranslateFrom={setAddTranslateFrom}
        addTranslateTo={addTranslateTo}
        setAddTranslateTo={setAddTranslateTo}
        busy={busy}
        speechLang={speechLang}
        setSpeechLang={setSpeechLang}
        speechRecognition={SR}
        addListening={addListening}
        lastAddMicClickRef={lastAddMicClickRef}
        stopAddMic={stopAddMic}
        startAddMic={startAddMic}
        activeAddList={activeAddList}
        renderAddFieldInput={renderAddFieldInput}
        submitAddTranslate={submitAddTranslate}
        submitAdd={submitAdd}
        validateAddForm={validateAddForm}
        fieldEditOpen={fieldEditOpen}
        setFieldEditOpen={setFieldEditOpen}
        fieldEditRow={fieldEditRow}
        setFieldEditRow={setFieldEditRow}
        fieldEditName={fieldEditName}
        fieldEditValue={fieldEditValue}
        setFieldEditValue={setFieldEditValue}
        confirmFieldEdit={confirmFieldEdit}
        fieldEditErr={fieldEditErr}
        setFieldEditErr={setFieldEditErr}
        editOpen={editOpen}
        setEditOpen={setEditOpen}
        editRow={editRow}
        editDraft={editDraft}
        setEditDraft={setEditDraft}
        editOriginalDraft={editOriginalDraft}
        confirmEdit={confirmEdit}
        editErr={editErr}
        setEditErr={setEditErr}
        translateOpen={translateOpen}
        translateRow={translateRow}
        translateInitial={translateInitial}
        closeTranslateModal={closeTranslateModal}
        llmRefine={llmRefine}
        saveTranslation={saveTranslation}
        deleteTranslation={deleteTranslation}
        undoToast={undoToast ? { id: undoToast.id, label: undoToast.label } : null}
        executeUndo={executeUndo}
        undoBusy={undoBusy}
        dismissUndoToast={dismissUndoToast}
        undoConfirm={undoConfirm}
        setUndoConfirm={setUndoConfirm}
        err={err}
      />
    </div>
  );
}
