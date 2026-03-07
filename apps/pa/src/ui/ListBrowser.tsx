import React from "react";
import { API_BASE, api } from "../api";
import type { FieldDef, ListItem } from "@shared/model";
import { DndContext, closestCenter, MouseSensor, TouchSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  DEFAULT_SPEECH_LANG_VALUE,
  SPEECH_LANG_OPTIONS,
  SPEECH_LANG_STORAGE_KEY,
  getSpeechRecognition,
  resolveSpeechLang,
  type SpeechRecognitionLike,
} from "./speech";
import { COLOR_PALETTE, STATUS_OPTIONS, STATUS_STYLE, type StatusValue } from "./listBrowser/constants";
import {
  ColorPicker,
  ColorSelect,
  ColorSwatch,
  SortableTr,
  StatusBadge,
  StatusPicker,
  StatusSelect,
  ToggleSwitch,
  useDismissibleDetails,
} from "./listBrowser/components";
import { TranslateModal } from "./TranslateModal";
import {
  isTranslateLike,
  TRANSLATE_LIST_ID,
  TRANSLATE_LANG_VALUES,
  TranslationPayloadZ,
  translateLangFlag,
  translateLangLabel,
  type TranslateLang,
  type TranslationPayload,
} from "./translate";

// Field types that need a click-to-edit modal (not natively interactive)
const EDITABLE_FIELD_TYPES = new Set(["string", "int", "float", "date", "time", "json"]);
import { byMultiSort, type SortLayer, fieldLabel, hexToRgba, linkifyText, moveArrayItem } from "./listBrowser/utils";

type ListInfo = {
  id: string;
  title: string;
  description: string;
  aliases: string[];
  fields: Record<string, FieldDef>;
  meta: { revision: number; itemsUpdatedAt: string; itemsUpdatedBy: string | null };
};

type ItemRow = ListItem & { __listId: string };

type UndoLogEntryLight = {
  id: string;
  label: string;
  itemCount: number;
  listIds: string[];
  createdAt: string;
};

type UndoToast = { id: string; label: string; timerId: number };
type UndoConfirm = { ids: string[] };

export function ListBrowser(props: {
  refreshSignal: number;
  translateIntent?: string | null;
  onTranslateIntentHandled?: () => void;
}) {
  const SR = getSpeechRecognition();
  const [lists, setLists] = React.useState<ListInfo[]>([]);
  const [listId, setListId] = React.useState<string>("");
  const [items, setItems] = React.useState<ListItem[]>([]);
  const [stale, setStale] = React.useState<{ current: number; db: number } | null>(null);
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
  const [busy, setBusy] = React.useState(false);
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
  // Translate modal
  const [translateOpen, setTranslateOpen] = React.useState(false);
  const [translateRow, setTranslateRow] = React.useState<ItemRow | null>(null);
  const [translateInitial, setTranslateInitial] = React.useState<TranslationPayload | null>(null);
  // Multi-select for bulk delete
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  // Expanded accordion rows
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());
  const [searchRows, setSearchRows] = React.useState<ItemRow[] | null>(null);
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
  const addMicHoldActiveRef = React.useRef(false);
  const suppressAddMicClickRef = React.useRef(false);
  const coarsePointerRef = React.useRef(false);
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

  // Undo mode
  const [undoMode, setUndoMode] = React.useState(false);
  const [undoLog, setUndoLog] = React.useState<UndoLogEntryLight[]>([]);
  const [undoSelectedIds, setUndoSelectedIds] = React.useState<Set<string>>(new Set());
  const [undoToast, setUndoToast] = React.useState<UndoToast | null>(null);
  const [undoConfirm, setUndoConfirm] = React.useState<UndoConfirm | null>(null);
  const [undoBusy, setUndoBusy] = React.useState(false);

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

  async function loadLists() {
    setErr(null);
    const data = await api<{ lists: ListInfo[] }>("/lists", { method: "GET" });
    setLists(data.lists);
    setStale(null);
    if (!listId) {
      const preferred = data.lists.find((l) => String(l.title).toLowerCase() === "translate")?.id
        ?? data.lists.find((l) => l.id === "app")?.id
        ?? data.lists[0]?.id
        ?? "";
      if (preferred) setListId(preferred);
    }
  }

  async function loadItems(id: string) {
    if (!id) return;
    setBusy(true);
    setErr(null);
    try {
      const data = await api<{ items: ListItem[] }>(`/lists/${encodeURIComponent(id)}/items`, {
        method: "GET",
      });
      setItems(data.items);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function loadAllRows() {
    setBusy(true);
    setErr(null);
    try {
      const pairs = await Promise.all(
        lists.map(async (l) => {
          const data = await api<{ items: ListItem[] }>(`/lists/${encodeURIComponent(l.id)}/items`, {
            method: "GET",
          });
          return data.items.map((it) => ({ ...(it as any), __listId: l.id }) as ItemRow);
        }),
      );
      const all = pairs.flat();
      setSearchRows(all);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  React.useEffect(() => {
    loadLists().catch((e) => setErr(String(e?.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    loadLists().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshSignal]);

  React.useEffect(() => {
    if (!listId) return;
    if (searchAllLists) return;
    setSearchRows(null);
    loadItems(listId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId, props.refreshSignal, searchAllLists]);

  React.useEffect(() => {
    if (!searchAllLists) return;
    if (lists.length === 0) return;
    loadAllRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchAllLists, props.refreshSignal, lists.length]);

  const sortedLists = React.useMemo(() => {
    const copy = [...lists];
    copy.sort((a, b) => {
      const aIsTranslate = String(a.title ?? "").toLowerCase() === "translate";
      const bIsTranslate = String(b.title ?? "").toLowerCase() === "translate";
      if (aIsTranslate && !bIsTranslate) return -1;
      if (bIsTranslate && !aIsTranslate) return 1;
      const byTitle = String(a.title ?? "").localeCompare(String(b.title ?? ""), undefined, { sensitivity: "base" });
      if (byTitle !== 0) return byTitle;
      return String(a.id ?? "").localeCompare(String(b.id ?? ""), undefined, { sensitivity: "base" });
    });
    return copy;
  }, [lists]);

  const activeList = lists.find((l) => l.id === listId) ?? null;

  function findItemUpdatedAt(targetListId: string, itemId: string): string | undefined {
    if (!itemId) return undefined;
    if (searchAllLists) {
      const row = searchRows?.find((r) => r.__listId === targetListId && r.id === itemId) ?? null;
      const v = (row as any)?.updatedAt;
      return typeof v === "string" ? v : undefined;
    }
    if (targetListId !== listId) return undefined;
    const row = items.find((it: any) => it.id === itemId) as any;
    const v = row?.updatedAt;
    return typeof v === "string" ? v : undefined;
  }

  React.useEffect(() => {
    if (!listId) return;
    if (!activeList) return;
    let cancelled = false;

    async function poll() {
      try {
        const data = await api<{ lists: ListInfo[] }>("/lists", { method: "GET" });
        if (cancelled) return;
        const dbRev = data.lists.find((l) => l.id === listId)?.meta?.revision;
        const curRev = activeList.meta?.revision;
        if (typeof dbRev === "number" && typeof curRev === "number" && dbRev !== curRev) {
          setStale({ current: curRev, db: dbRev });
        }
      } catch {
        // ignore
      }
    }

    poll();
    const handle = window.setInterval(poll, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listId, activeList?.meta?.revision]);
  const visibleRows: ItemRow[] = (searchAllLists && searchRows
    ? searchRows
    : items.map((it) => ({ ...(it as any), __listId: listId }) as ItemRow)
  ).filter((it) => {
    const txt = String(it.text ?? "");
    if (filterText.trim()) {
      if (!txt.toLowerCase().includes(filterText.trim().toLowerCase())) return false;
    }
    if (filterPriority !== "") {
      if ((it.priority ?? 3) !== filterPriority) return false;
    }
    if (filterColor !== "") {
      if (String(it.color ?? "").toLowerCase() !== String(filterColor).toLowerCase()) return false;
    }
    if (filterTopic.trim()) {
      if (String((it as any).topic ?? "").toLowerCase() !== filterTopic.trim().toLowerCase()) return false;
    }
    if (!showArchived) {
      const archivedAt = (it as any).archivedAt;
      if (typeof archivedAt === "string" && archivedAt.trim()) return false;
      if (archivedAt === true) return false;
    }
    return true;
  });

  const filtered = visibleRows.sort(byMultiSort(sortLayers));
  const filteredById = new Map(filtered.map((r) => [r.id, r]));
  const displayRows = reorderMode ? (reorderIds.map((id) => filteredById.get(id)).filter(Boolean) as ItemRow[]) : filtered;

  const topics = Array.from(
    new Set(
      visibleRows
        .map((it) => String((it as any).topic ?? "").trim())
        .filter((t) => t.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));

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

  function rowToTranslationPayload(row: ItemRow): TranslationPayload {
    const originLanguage = typeof (row as any).originLanguage === "string" ? String((row as any).originLanguage) : "";
    const destinationLanguage =
      typeof (row as any).destinationLanguage === "string" ? String((row as any).destinationLanguage) : "";
    const originExpression =
      typeof (row as any).originExpression === "string"
        ? String((row as any).originExpression)
        : String((row as any).text ?? "");
    const possibleTranslations = Array.isArray((row as any).possibleTranslations) ? (row as any).possibleTranslations : [];
    const examplesOrigin = Array.isArray((row as any).examplesOrigin) ? (row as any).examplesOrigin : [];
    const examplesDestination = Array.isArray((row as any).examplesDestination) ? (row as any).examplesDestination : [];
    const comments = typeof (row as any).comments === "string" ? String((row as any).comments) : "";
    return {
      originLanguage: originLanguage as any,
      originExpression,
      destinationLanguage: destinationLanguage as any,
      possibleTranslations: possibleTranslations.map((s: any) => String(s ?? "")),
      examplesOrigin: examplesOrigin.map((s: any) => String(s ?? "")),
      examplesDestination: examplesDestination.map((s: any) => String(s ?? "")),
      comments,
    };
  }

  function openTranslateModal(row: ItemRow, initial?: TranslationPayload) {
    setTranslateRow(row);
    setTranslateInitial(initial ?? rowToTranslationPayload(row));
    setTranslateOpen(true);
  }

  async function ensureTranslateListReady() {
    const requiredFields: Record<string, FieldDef> = {
      originLanguage: { type: "string", nullable: true, description: "Origin language (BCP-47)", ui: { showInPreview: true } },
      originExpression: { type: "string", nullable: true, description: "Origin expression", ui: { showInPreview: true } },
      destinationLanguage: { type: "string", nullable: true, description: "Destination language (BCP-47)", ui: { showInPreview: true } },
      possibleTranslations: { type: "json", nullable: true, description: "Possible translations", ui: { showInPreview: false } },
      examplesOrigin: { type: "json", nullable: true, description: "Examples in origin language", ui: { showInPreview: false } },
      examplesDestination: { type: "json", nullable: true, description: "Examples in destination language", ui: { showInPreview: false } },
      comments: { type: "string", nullable: true, description: "Comments", ui: { showInPreview: false } },
    };

    const existing = lists.find((l) => l.id === TRANSLATE_LIST_ID) ?? null;
    if (!existing) {
      await commit({
        type: "create_list",
        valid: true,
        confidence: 1,
        listId: TRANSLATE_LIST_ID,
        title: "Translate",
        aliases: ["translation", "translations"],
        fields: requiredFields,
      });
      return;
    }

    const missing = Object.entries(requiredFields)
      .filter(([k]) => !existing.fields[k])
      .map(([name, def]) => ({
        name,
        type: def.type,
        ...(Object.prototype.hasOwnProperty.call(def, "default") ? { default: (def as any).default } : {}),
        ...(typeof def.nullable === "boolean" ? { nullable: def.nullable } : {}),
        ...(typeof def.description === "string" ? { description: def.description } : {}),
      }));
    if (missing.length > 0) {
      await commit({
        type: "add_fields",
        valid: true,
        confidence: 1,
        listId: TRANSLATE_LIST_ID,
        fieldsToAdd: missing,
      });
    }
  }

  async function llmTranslate(input: string): Promise<TranslationPayload> {
    const res = await api<{ ok: true; translation: unknown }>("/translate", {
      method: "POST",
      body: JSON.stringify({ input }),
    });
    return TranslationPayloadZ.parse(res.translation);
  }

  async function llmRefine(draft: TranslationPayload, question: string): Promise<{ translation: TranslationPayload; answer: string }> {
    const res = await api<{ ok: true; translation: unknown; answer: unknown }>("/translate/refine", {
      method: "POST",
      body: JSON.stringify({ draft, question }),
    });
    return { translation: TranslationPayloadZ.parse(res.translation), answer: String((res as any).answer ?? "") };
  }

  async function handleTranslateIntentInput(input: string, extra?: { priority?: number; color?: string | null; status?: string }) {
    setErr(null);
    setBusy(true);
    try {
      await ensureTranslateListReady();
      const translation = await llmTranslate(input);
      const originExpression = String(translation.originExpression ?? "").trim() || input.trim();
      const result = await commit(
        {
          type: "append_item",
          valid: true,
          confidence: 1,
          listId: TRANSLATE_LIST_ID,
          fields: {
            ...(extra?.priority !== undefined ? { priority: extra.priority } : {}),
            ...(extra?.color != null ? { color: extra.color } : {}),
            ...(extra?.status !== undefined ? { status: extra.status } : {}),
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
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  React.useEffect(() => {
    if (!props.translateIntent) return;
    props.onTranslateIntentHandled?.();
    handleTranslateIntentInput(props.translateIntent);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.translateIntent]);

  function showUndoToast(id: string, label: string) {
    setUndoToast((prev) => {
      if (prev?.timerId) window.clearTimeout(prev.timerId);
      const timerId = window.setTimeout(() => setUndoToast(null), 7000);
      return { id, label, timerId };
    });
  }

  function dismissUndoToast() {
    setUndoToast((prev) => {
      if (prev?.timerId) window.clearTimeout(prev.timerId);
      return null;
    });
  }

  async function loadUndoLog() {
    const res = await api<{ entries: UndoLogEntryLight[] }>("/undo");
    setUndoLog(res.entries);
  }

  async function enterUndoMode() {
    setErr(null);
    setUndoSelectedIds(new Set());
    try {
      await loadUndoLog();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    setUndoMode(true);
  }

  function exitUndoMode() {
    setUndoMode(false);
    setUndoSelectedIds(new Set());
  }

  function toggleUndoSelect(id: string) {
    setUndoSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function executeUndo(ids: string[], confirmed: boolean) {
    setUndoBusy(true);
    setErr(null);
    setStale(null);
    try {
      for (const id of ids) {
        const res = await api<{ ok: boolean; conflicts?: boolean }>("/undo", {
          method: "POST",
          body: JSON.stringify({ id, confirmed }),
        });
        if (!confirmed && res.conflicts) {
          setUndoConfirm({ ids });
          return;
        }
      }
      dismissUndoToast();
      await loadLists().catch(() => {});
      if (searchAllLists) await loadAllRows();
      else await loadItems(listId);
      if (undoMode) await loadUndoLog();
      setUndoSelectedIds(new Set());
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setUndoBusy(false);
    }
  }

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
      { expectedItemUpdatedAt: findItemUpdatedAt(targetListId, itemId) },
    );
  }

  async function setColor(targetListId: string, itemId: string, color: string | null) {
    await commit(
      { type: "update_item", valid: true, confidence: 1, listId: targetListId, itemId, patch: { color } },
      { expectedItemUpdatedAt: findItemUpdatedAt(targetListId, itemId) },
    );
  }

  async function setStatusAny(targetListId: string, itemId: string, status: StatusValue) {
    await ensureStatusField(targetListId);
    await commit(
      { type: "update_item", valid: true, confidence: 1, listId: targetListId, itemId, patch: { status } },
      { expectedItemUpdatedAt: findItemUpdatedAt(targetListId, itemId) },
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
      { refresh: true, expectedItemUpdatedAt: findItemUpdatedAt(targetListId, itemId), undoLabel: "Archived item" },
    );
  }

  async function unarchiveItem(targetListId: string, itemId: string) {
    await ensureArchivedField(targetListId);
    await commit(
      { type: "update_item", valid: true, confidence: 1, listId: targetListId, itemId, patch: { archivedAt: null } },
      { expectedItemUpdatedAt: findItemUpdatedAt(targetListId, itemId) },
    );
  }

  async function del(targetListId: string, itemId: string) {
    await commit(
      { type: "delete_item", valid: true, confidence: 1, listId: targetListId, itemId },
      { expectedItemUpdatedAt: findItemUpdatedAt(targetListId, itemId), undoLabel: "Deleted item" },
    );
  }

  // Multi-select
  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(displayRows.map((r) => r.id)));
    }
  }

  async function deleteSelected() {
    if (selectedIds.size === 0) return;
    const confirmed = window.confirm(`Delete ${selectedIds.size} item${selectedIds.size !== 1 ? "s" : ""}?`);
    if (!confirmed) return;
    setBusy(true);
    setErr(null);
    try {
      const rows = displayRows.filter((r) => selectedIds.has(r.id));
      const label = `Deleted ${rows.length} item${rows.length !== 1 ? "s" : ""}`;
      await commit(
        {
          type: "batch",
          valid: true,
          confidence: 1,
          label,
          actions: rows.map((r) => ({ type: "delete_item", listId: r.__listId, itemId: r.id })),
        },
        { undoLabel: label },
      );
      setSelectedIds(new Set());
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function bulkUpdate(patch: Record<string, unknown>) {
    if (selectedIds.size === 0) return;
    setBusy(true);
    setErr(null);
    try {
      for (const id of selectedIds) {
        const row = displayRows.find((r) => r.id === id);
        if (!row) continue;
        await commit(
          { type: "update_item", valid: true, confidence: 1, listId: row.__listId, itemId: id, patch },
          { refresh: false, expectedItemUpdatedAt: findItemUpdatedAt(row.__listId, id) },
        );
      }
      setSelectedIds(new Set());
      if (searchAllLists) await loadAllRows();
      else await loadItems(listId);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function bulkMove(toListId: string) {
    if (selectedIds.size === 0 || !toListId) return;
    setBusy(true);
    setErr(null);
    try {
      for (const id of selectedIds) {
        const row = displayRows.find((r) => r.id === id);
        if (!row || row.__listId === toListId) continue;
        await commit(
          { type: "move_item", valid: true, confidence: 1, fromListId: row.__listId, toListId, itemId: id },
          { refresh: false, undoLabel: "Moved item" },
        );
      }
      setSelectedIds(new Set());
      if (searchAllLists) await loadAllRows();
      else await loadItems(listId);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function bulkSetStatus(status: StatusValue) {
    if (selectedIds.size === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const affectedListIds = Array.from(new Set(
        displayRows.filter((r) => selectedIds.has(r.id)).map((r) => r.__listId)
      ));
      for (const lid of affectedListIds) await ensureStatusField(lid);
      for (const id of selectedIds) {
        const row = displayRows.find((r) => r.id === id);
        if (!row) continue;
        await commit(
          { type: "update_item", valid: true, confidence: 1, listId: row.__listId, itemId: id, patch: { status } },
          { refresh: false, expectedItemUpdatedAt: findItemUpdatedAt(row.__listId, id) },
        );
      }
      setSelectedIds(new Set());
      if (searchAllLists) await loadAllRows();
      else await loadItems(listId);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function bulkArchive() {
    if (selectedIds.size === 0) return;
    setBusy(true);
    setErr(null);
    try {
      const now = new Date().toISOString();
      const listIds = Array.from(new Set(displayRows.filter((r) => selectedIds.has(r.id)).map((r) => r.__listId)));
      for (const lid of listIds) await ensureArchivedField(lid);
      for (const id of selectedIds) {
        const row = displayRows.find((r) => r.id === id);
        if (!row) continue;
        await commit(
          { type: "update_item", valid: true, confidence: 1, listId: row.__listId, itemId: id, patch: { archivedAt: now } },
          { refresh: false, expectedItemUpdatedAt: findItemUpdatedAt(row.__listId, id) },
        );
      }
      setSelectedIds(new Set());
      if (searchAllLists) await loadAllRows();
      else await loadItems(listId);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
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

  function onAddMicPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (!coarsePointerRef.current) return;
    if (!SR) return;
    suppressAddMicClickRef.current = true;
    addMicHoldActiveRef.current = true;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    if (!addListeningRef.current) startAddMic();
  }

  function onAddMicPointerUp(e?: React.PointerEvent<HTMLButtonElement>) {
    if (!coarsePointerRef.current) return;
    if (!addMicHoldActiveRef.current) return;
    addMicHoldActiveRef.current = false;
    if (e) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    }
    stopAddMic();
    window.setTimeout(() => {
      suppressAddMicClickRef.current = false;
    }, 0);
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
      {/* Topbar */}
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
            style={undoMode ? { background: "#1a90d4", color: "#fff", borderColor: "#1a90d4" } : {}}
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

      {/* Always-visible toolbar: scope + stats + filter toggle */}
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
              <span>{filtered.length}</span>
            </div>
          ) : null}
          <button
            className="iconbtn"
            onClick={() => setFiltersOpen((f) => !f)}
            style={{ flexShrink: 0, borderColor: "rgba(232,180,40,0.45)", color: "#e8b428", background: filtersOpen ? "rgba(232,180,40,0.12)" : "rgba(232,180,40,0.05)" }}
            title={filtersOpen ? "Hide filters" : "Show filters"}
          >
            {filtersOpen ? "− Filters" : "+ Filters"}
          </button>
          <button
            className="iconbtn"
            onClick={() => { setSortDraft([...sortLayers]); setSortModalOpen(true); }}
            style={{ flexShrink: 0, borderColor: "rgba(122,162,255,0.45)", color: "var(--accent)", background: sortLayers.length > 1 ? "rgba(122,162,255,0.12)" : "rgba(122,162,255,0.05)" }}
            title="Sort by"
          >
            ↕ Sort{sortLayers.length > 1 ? ` (${sortLayers.length})` : ""}
          </button>
        </div>
      ) : null}

      {/* Bulk bar — always visible when items selected (ignores filtersOpen) */}
      {!reorderMode && !undoMode && selectedIds.size > 0 ? (
        <div className="filterBar bulkBar">
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0", flexShrink: 0 }}>
            <span style={{ fontWeight: 600, color: "var(--danger)", fontSize: 13 }}>{selectedIds.size} selected</span>
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
            <button onClick={bulkArchive} disabled={busy}>Archive ({selectedIds.size})</button>
          </div>
          <div className="filterItem">
            <label className="small muted">Delete</label>
            <button className="danger" onClick={deleteSelected} disabled={busy}>Delete ({selectedIds.size})</button>
          </div>
        </div>
      ) : null}

      {/* Expandable filter bar — shown when filtersOpen and no bulk selection */}
      {!reorderMode && !undoMode && filtersOpen && selectedIds.size === 0 ? (
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
              <button onClick={unarchiveAllInScope} disabled={busy || unarchiveCandidates.length === 0}>Unarchive all ({unarchiveCandidates.length})</button>
            ) : (
              <button onClick={archiveAllDoneInScope} disabled={busy || archiveDoneCandidates.length === 0}>Archive done ({archiveDoneCandidates.length})</button>
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

      {/* Undo history table */}
      {undoMode ? (
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
      ) : null}

      {undoMode ? (
        <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
          <button
            style={{ background: "#1a90d4", color: "#fff", borderColor: "#1a90d4" }}
            onClick={() => executeUndo(Array.from(undoSelectedIds), false)}
            disabled={undoBusy || undoSelectedIds.size === 0}
          >
            Undo selected ({undoSelectedIds.size})
          </button>
        </div>
      ) : null}

      {/* Table */}
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
                          <select
                            value={String(it.priority ?? 3)}
                            onChange={(e) => setPriority(it.__listId, it.id, Number(e.target.value))}
                          >
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
                              {/* For translate rows, the modal covers all fields — skip raw field cells */}
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
                                  <button className="iconbtn" onClick={() => openTranslateModal(it)} title="Open translate modal">
                                    ✎
                                  </button>
                                </div>
                              ) : null}
                              <div className="expandField">
                                <span className="small muted">Raw</span>
                                <button className="iconbtn" onClick={() => openEdit(it)}>
                                  Edit JSON
                                </button>
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

      {sortModalOpen ? (() => {
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
        );
      })() : null}

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
              <button
                onClick={() => {
                  setAddOpen(false);
                  setAddErr(null);
                }}
              >
                Close
              </button>
            </div>
          </div>

          <div className="formRow">
            <div className="formCol">
              <label className="small muted">List</label>
              <select value={addListId || ""} onChange={(e) => setAddListId(e.target.value)}>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="formCol">
              <label className="small muted">Priority</label>
              <select
                value={String((addFields.priority as any) ?? 3)}
                onChange={(e) => setAddField("priority", Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
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
                  {TRANSLATE_LANG_VALUES.map((v) => (
                    <option key={v} value={v}>{translateLangFlag(v)} {translateLangLabel(v)}</option>
                  ))}
                </select>
              </div>
              <button
                className="iconbtn"
                style={{ marginBottom: 2, flexShrink: 0 }}
                onClick={() => { const t = addTranslateFrom; setAddTranslateFrom(addTranslateTo); setAddTranslateTo(t); }}
                disabled={busy}
                title="Swap languages"
              >
                ⇄
              </button>
              <div className="formCol" style={{ minWidth: 120 }}>
                <label className="small muted">To</label>
                <select value={addTranslateTo} onChange={(e) => setAddTranslateTo(e.target.value as TranslateLang | "")} disabled={busy}>
                  <option value="">—</option>
                  {TRANSLATE_LANG_VALUES.map((v) => (
                    <option key={v} value={v}>{translateLangFlag(v)} {translateLangLabel(v)}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
            <label className="small muted">Text *</label>
            <div className="row" style={{ alignItems: "center", gap: 8 }}>
              <select
                value={speechLang}
                onChange={(e) => setSpeechLang(e.target.value)}
                disabled={!SR}
                title="Speech language"
              >
                {SPEECH_LANG_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <button
                className="iconbtn"
                onClick={() => {
                  if (suppressAddMicClickRef.current) return;
                  if (coarsePointerRef.current) return;
                  if (addListening) stopAddMic();
                  else startAddMic();
                }}
                onPointerDown={onAddMicPointerDown}
                onPointerUp={onAddMicPointerUp}
                onPointerCancel={onAddMicPointerUp}
                disabled={!SR}
                title={!SR ? "SpeechRecognition not supported in this browser" : ""}
                data-mic="add"
              >
                {addListening ? "Stop 🎙" : "Mic 🎙"}
              </button>
            </div>
          </div>
          <textarea value={String(addFields.text ?? "")} onChange={(e) => setAddField("text", e.target.value)} />

          {!isAddTranslateMode && activeAddList() ? (
            <div style={{ marginTop: 10 }}>
              <div className="muted small" style={{ marginBottom: 6 }}>
                Extra fields
              </div>
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
            <button
              className="danger"
              onClick={() => {
                setAddOpen(false);
                stopAddMic();
                setAddErr(null);
              }}
            >
              Cancel
            </button>
          </div>

          {addErr ? (
            <div style={{ marginTop: 10 }} className="error small">
              {addErr}
            </div>
          ) : null}
        </dialog>
        </>
      ) : null}

      {/* Single-field edit modal */}
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

      {/* Full JSON edit modal (from expanded panel) */}
      {editOpen && editRow ? (
        <>
          <div className="dialogOverlay" onClick={() => { setEditOpen(false); setEditRow(null); setEditDraft(""); setEditOriginalDraft(""); setEditErr(null); }} />
          <dialog open className="dialog">
          <div className="topbar" style={{ marginBottom: 12 }}>
            <div>
              <div className="title">Edit item (JSON)</div>
              <div className="muted small">
                {lists.find((l) => l.id === editRow.__listId)?.title ?? editRow.__listId} • {editRow.id.slice(0, 12)}
              </div>
            </div>
            <div className="btnrow">
              <button onClick={() => setEditOpen(false)}>Close</button>
            </div>
          </div>
          <label className="small muted">Fields JSON (patch)</label>
          <textarea
            value={editDraft}
            onChange={(e) => { setEditDraft(e.target.value); setEditErr(null); }}
            style={{ fontFamily: "monospace" }}
          />
          <div style={{ marginTop: 10 }} className="btnrow">
            <button className="primary" onClick={confirmEdit} disabled={!editDraft.trim() || editDraft === editOriginalDraft} title={editDraft === editOriginalDraft ? "No changes" : ""}>
              Save
            </button>
            <button className="danger" onClick={() => { setEditOpen(false); setEditRow(null); setEditDraft(""); setEditOriginalDraft(""); setEditErr(null); }}>
              Cancel
            </button>
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
          onClose={() => {
            setTranslateOpen(false);
            setTranslateRow(null);
            setTranslateInitial(null);
          }}
          onRepeat={async (draft, question) => await llmRefine(draft, question)}
          onSave={async (next) => {
            if (!translateRow) return;
            const expr = String(next.originExpression ?? "").trim();
            await commit(
              {
                type: "update_item",
                valid: true,
                confidence: 1,
                listId: translateRow.__listId,
                itemId: translateRow.id,
                patch: {
                  text: expr || String((translateRow as any).text ?? ""),
                  originLanguage: next.originLanguage,
                  originExpression: next.originExpression,
                  destinationLanguage: next.destinationLanguage,
                  possibleTranslations: next.possibleTranslations,
                  examplesOrigin: next.examplesOrigin,
                  examplesDestination: next.examplesDestination,
                  comments: next.comments,
                },
              },
              { undoLabel: `Updated translation: ${expr.slice(0, 40) || "item"}` },
            );
          }}
          onDelete={async () => {
            if (!translateRow) return;
            await commit(
              { type: "delete_item", valid: true, confidence: 1, listId: translateRow.__listId, itemId: translateRow.id },
              { undoLabel: `Deleted translation: ${String((translateRow as any).originExpression ?? translateRow.text ?? "").slice(0, 40)}` },
            );
          }}
        />
      ) : null}

      {/* Undo toast */}
      {undoToast && (
        <div style={{
          position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
          background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8,
          padding: "10px 16px", display: "flex", alignItems: "center", gap: 12,
          zIndex: 1000, color: "#e7ecff", boxShadow: "0 4px 20px rgba(0,0,0,0.4)",
        }}>
          <span className="small">{undoToast.label}</span>
          <button
            onClick={() => executeUndo([undoToast.id], false)}
            disabled={undoBusy}
            style={{ background: "#1a90d4", color: "#fff", borderColor: "#1a90d4" }}
          >
            Undo
          </button>
          <button className="iconbtn" onClick={dismissUndoToast}>×</button>
        </div>
      )}

      {/* Undo conflict confirm */}
      {undoConfirm && (
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
              <button
                className="primary"
                onClick={async () => {
                  const ids = undoConfirm.ids;
                  setUndoConfirm(null);
                  await executeUndo(ids, true);
                }}
              >
                Yes, undo all
              </button>
              <button onClick={() => setUndoConfirm(null)}>Cancel</button>
            </div>
          </dialog>
        </>
      )}

      {err ? (
        <div style={{ marginTop: 10 }} className="error small">
          {err}
        </div>
      ) : null}

      {busy ? (
        <div style={{
          position: "fixed",
          inset: 0,
          zIndex: 500,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "rgba(0, 0, 0, 0.35)",
          backdropFilter: "blur(2px)",
          WebkitBackdropFilter: "blur(2px)",
        }}>
          <div className="spinner spinnerLg" title="Loading…" />
        </div>
      ) : null}
    </div>
  );
}
