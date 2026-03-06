import React from "react";
import { API_BASE, api } from "../api";
import type { FieldDef, ListItem } from "@shared/model";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { getSpeechRecognition, type SpeechRecognitionLike } from "./speech";
import { COLOR_PALETTE, type StatusValue } from "./listBrowser/constants";
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
import { bySortKey, fieldLabel, hexToRgba, linkifyText, moveArrayItem } from "./listBrowser/utils";

type ListInfo = {
  id: string;
  title: string;
  description: string;
  aliases: string[];
  fields: Record<string, FieldDef>;
  meta: { revision: number; itemsUpdatedAt: string; itemsUpdatedBy: string | null };
};

type ItemRow = ListItem & { __listId: string };

export function ListBrowser(props: { refreshSignal: number }) {
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

  const [sortKey, setSortKey] = React.useState("createdAt");
  const [sortDir, setSortDir] = React.useState<"asc" | "desc">("desc");
  const [reorderPriority, setReorderPriority] = React.useState<number>(3);
  const [reorderMode, setReorderMode] = React.useState(false);
  const [reorderIds, setReorderIds] = React.useState<string[]>([]);
  const reorderBackupRef = React.useRef<{
    filterText: string;
    filterPriority: number | "";
    filterColor: string | "";
    filterTopic: string;
    showArchived: boolean;
    sortKey: string;
    sortDir: "asc" | "desc";
    searchAllLists: boolean;
  } | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);
  const [editRow, setEditRow] = React.useState<ItemRow | null>(null);
  const [editDraft, setEditDraft] = React.useState("");
  const [editOriginalDraft, setEditOriginalDraft] = React.useState("");
  const [editErr, setEditErr] = React.useState<string | null>(null);
  const [searchRows, setSearchRows] = React.useState<ItemRow[] | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);
  const [addListId, setAddListId] = React.useState<string>("");
  const [addFields, setAddFields] = React.useState<Record<string, unknown>>({});
  const [addStatus, setAddStatus] = React.useState<StatusValue>("todo");
  const [addColor, setAddColor] = React.useState<string | null>(null);
  const [addErr, setAddErr] = React.useState<string | null>(null);
  const [addListening, setAddListening] = React.useState(false);
  const addRecRef = React.useRef<SpeechRecognitionLike | null>(null);
  const addMicBaseRef = React.useRef<string>("");
  const addMicFinalRef = React.useRef<string>("");
  const addMicRestartTimerRef = React.useRef<number | null>(null);

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
      const preferred = data.lists.find((l) => l.id === "app")?.id ?? data.lists[0]?.id ?? "";
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

  const filtered = visibleRows.sort(bySortKey(sortKey, sortDir));
  const filteredById = new Map(filtered.map((r) => [r.id, r]));
  const displayRows = reorderMode ? reorderIds.map((id) => filteredById.get(id)).filter(Boolean) : filtered;

  const topics = Array.from(
    new Set(
      visibleRows
        .map((it) => String((it as any).topic ?? "").trim())
        .filter((t) => t.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));

  function toggleSort(key: string) {
    if (reorderMode) return;
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("asc");
      return;
    }
    setSortDir((d) => (d === "asc" ? "desc" : "asc"));
  }

  async function commit(action: any, opts?: { refresh?: boolean; expectedItemUpdatedAt?: string }) {
    try {
      await api("/commit", {
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

    await loadLists().catch(() => {});
    const refresh = opts?.refresh !== false;
    if (refresh) {
      if (searchAllLists) await loadAllRows();
      else await loadItems(listId);
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
      { refresh: true, expectedItemUpdatedAt: findItemUpdatedAt(targetListId, itemId) },
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
      { expectedItemUpdatedAt: findItemUpdatedAt(targetListId, itemId) },
    );
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
      sortKey,
      sortDir,
      searchAllLists,
    };
    setReorderMode(true);
    setFilterPriority(reorderPriority);
    setShowArchived(false);
    setSortKey("order");
    setSortDir("asc");
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
    setSortKey(b.sortKey);
    setSortDir(b.sortDir);
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
      const now = new Date().toISOString();
      const byList = new Map<string, Array<{ id: string; updatedAt?: string }>>();
      for (const it of archiveDoneCandidates) {
        const lid = it.__listId;
        if (!byList.has(lid)) byList.set(lid, []);
        byList.get(lid)!.push({ id: it.id, updatedAt: (it as any).updatedAt });
      }

      for (const [lid, rows] of byList.entries()) {
        await ensureArchivedField(lid);
        for (const { id: itemId, updatedAt } of rows) {
          await commit(
            { type: "update_item", valid: true, confidence: 1, listId: lid, itemId, patch: { archivedAt: now } },
            { refresh: false, expectedItemUpdatedAt: updatedAt ?? findItemUpdatedAt(lid, itemId) },
          );
        }
      }

      if (searchAllLists) await loadAllRows();
      else await loadItems(listId);
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
      const byList = new Map<string, Array<{ id: string; updatedAt?: string }>>();
      for (const it of unarchiveCandidates) {
        const lid = it.__listId;
        if (!byList.has(lid)) byList.set(lid, []);
        byList.get(lid)!.push({ id: it.id, updatedAt: (it as any).updatedAt });
      }

      for (const [lid, rows] of byList.entries()) {
        await ensureArchivedField(lid);
        for (const { id: itemId, updatedAt } of rows) {
          await commit(
            { type: "update_item", valid: true, confidence: 1, listId: lid, itemId, patch: { archivedAt: null } },
            { refresh: false, expectedItemUpdatedAt: updatedAt ?? findItemUpdatedAt(lid, itemId) },
          );
        }
      }

      if (searchAllLists) await loadAllRows();
      else await loadItems(listId);
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
        { expectedItemUpdatedAt: (editRow as any).updatedAt },
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
    await commit({ type: "move_item", valid: true, confidence: 1, fromListId, toListId, itemId });
  }

  function openAdd() {
    setAddErr(null);
    setAddOpen(true);
    setAddListId(listId || lists.find((l) => l.id === "app")?.id || lists[0]?.id || "");
    setAddFields({ text: "" });
    setAddStatus("todo");
    setAddColor(null);
  }

  function stopAddMic() {
    if (addMicRestartTimerRef.current) {
      window.clearTimeout(addMicRestartTimerRef.current);
      addMicRestartTimerRef.current = null;
    }
    addRecRef.current?.stop();
    setAddListening(false);
  }

  function startAddMic() {
    if (!SR) return;
    setAddErr(null);

    // Keep what's already in the field and append dictation to it.
    addMicBaseRef.current = String(addFields.text ?? "").trim();
    addMicFinalRef.current = "";

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
      const code = String(ev?.error ?? "unknown");
      // Many browsers emit "no-speech" when you pause; keep the mic "on" by restarting.
      if (addListening && ["no-speech", "audio-capture", "network"].includes(code)) return;
      setAddErr(`Speech error: ${code}`);
      stopAddMic();
    };
    rec.onend = () => {
      // Auto-restart to tolerate silence gaps while the mic toggle is "on".
      if (!addListening) return;
      if (addMicRestartTimerRef.current) window.clearTimeout(addMicRestartTimerRef.current);
      addMicRestartTimerRef.current = window.setTimeout(() => {
        try {
          addRecRef.current?.start();
        } catch {
          // ignore
        }
      }, 250);
    };
    addRecRef.current = rec;
    setAddListening(true);
    rec.start();
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
      .filter(([name]) => !["order"].includes(name))
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
    const required = requiredFieldNamesForList(l);
    for (const name of required) {
      const v = addFields[name];
      if (typeof v === "string") {
        if (!v.trim()) return `Missing required field: ${name}`;
      } else if (v === undefined || v === null) {
        return `Missing required field: ${name}`;
      }
    }
    const text = String(addFields.text ?? "");
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
      await ensureStatusFieldIfUsed(l.id);
      await commit({ type: "append_item", valid: true, confidence: 1, listId: l.id, fields });
      setAddOpen(false);
      setAddListId("");
      setAddFields({});
      setAddColor(null);
      setAddStatus("todo");
    } catch (e: any) {
      setAddErr(String(e?.message ?? e));
    }
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
          <div key={fieldName} className="col">
            <label className="small muted">{label}</label>
            <input value={typeof val === "string" ? val : String(val ?? "")} onChange={(e) => setAddField(fieldName, e.target.value)} />
          </div>
        );
      case "int":
      case "float":
        return (
          <div key={fieldName} className="col">
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
          <div key={fieldName} className="col">
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
          <div key={fieldName} className="col">
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
          <div key={fieldName} className="col">
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
          <div key={fieldName} className="col">
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
    if (!addOpen) stopAddMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addOpen]);

  return (
    <div className="card">
      <div className="topbar" style={{ marginBottom: 10 }}>
        <div>
          <div className="title">Lists</div>
          <div className="muted small">Browse • filter • sort • export • reorder</div>
        </div>
        <div className="btnrow">
          <button className="primary" onClick={openAdd} disabled={!listId && lists.length === 0}>
            + Add item
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

      {activeList ? (
        <div className="row" style={{ marginBottom: 10 }}>
          <div className="col">
            <div className="pill small">
              <span className="muted">Items</span>
              <span>{searchAllLists ? (searchRows?.length ?? 0) : items.length}</span>
              <span className="muted">Filtered</span>
              <span>{filtered.length}</span>
            </div>
          </div>
          <div className="col">
            <div className="btnrow" style={{ justifyContent: "flex-end" }}>
              <a href={`${API_BASE}/export/${encodeURIComponent(listId)}.csv`} className="pill small">
                Download CSV
              </a>
              <a href={`${API_BASE}/export/${encodeURIComponent(listId)}.xlsx`} className="pill small">
                Download XLSX
              </a>
            </div>
          </div>
        </div>
      ) : null}

      <div className="row" style={{ marginBottom: 10, alignItems: "flex-end" }}>
        <div className="col">
          <label className="small muted">Filter text</label>
          <input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Search…"
            disabled={reorderMode}
          />
        </div>
        <div style={{ width: 180 }}>
          <label className="small muted">Scope</label>
          <select
            value={searchAllLists ? "__all__" : listId}
            onChange={(e) => {
              const next = e.target.value;
              if (next === "__all__") {
                setSearchAllLists(true);
                return;
              }
              setSearchAllLists(false);
              setListId(next);
            }}
            disabled={reorderMode}
          >
            <option value="__all__">All lists</option>
            {!searchAllLists && !listId ? (
              <option value="" disabled>
                Choose a list…
              </option>
            ) : null}
            {sortedLists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        </div>
        <div className="col">
          <label className="small muted">Priority</label>
          <select
            value={filterPriority === "" ? "" : String(filterPriority)}
            onChange={(e) => setFilterPriority(e.target.value ? Number(e.target.value) : "")}
            disabled={reorderMode}
          >
            <option value="">All</option>
            {[1, 2, 3, 4, 5].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div style={{ width: 220 }}>
          <label className="small muted">Color</label>
          <details className="menu" style={{ width: "100%" }} ref={filterColorMenuRef}>
            <summary className="iconbtn" style={{ width: "100%", justifyContent: "space-between" }}>
              <span className="muted small">Filter</span>
              {filterColor ? <ColorSwatch color={String(filterColor)} /> : <span className="muted small">All</span>}
            </summary>
            <div className="menuPanel" style={{ minWidth: 240 }}>
              <div className="swatchGrid">
                {COLOR_PALETTE.map((c) => (
                  <button
                    key={c}
                    className="swatchBtn"
                    onClick={() => {
                      setFilterColor(c);
                      filterColorMenuRef.current?.removeAttribute("open");
                    }}
                    title={c}
                    aria-label={c}
                    disabled={reorderMode}
                  >
                    <ColorSwatch color={c} size={18} />
                  </button>
                ))}
                <button
                  className="swatchBtn"
                  onClick={() => {
                    setFilterColor("");
                    filterColorMenuRef.current?.removeAttribute("open");
                  }}
                  title="All"
                  aria-label="All"
                  disabled={reorderMode}
                >
                  <span className="muted small">All</span>
                </button>
              </div>
            </div>
          </details>
        </div>
        <div style={{ width: 220 }}>
          <label className="small muted">Topic</label>
          <select value={filterTopic} onChange={(e) => setFilterTopic(e.target.value)} disabled={reorderMode}>
            <option value="">All</option>
            {topics.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div style={{ width: 170 }}>
          <label className="small muted">Show archived</label>
          <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
            <span />
            <ToggleSwitch
              checked={showArchived}
              onChange={setShowArchived}
              disabled={reorderMode}
              label="Show archived"
            />
          </div>
        </div>
        <div style={{ width: 200 }}>
          <label className="small muted">Bulk</label>
          {showArchived ? (
            <button
              onClick={unarchiveAllInScope}
              disabled={reorderMode || busy || unarchiveCandidates.length === 0}
              title={unarchiveCandidates.length === 0 ? "No archived items in current view" : ""}
            >
              Unarchive all ({unarchiveCandidates.length})
            </button>
          ) : (
            <button
              onClick={archiveAllDoneInScope}
              disabled={reorderMode || busy || archiveDoneCandidates.length === 0}
              title={archiveDoneCandidates.length === 0 ? "No done items to archive in current view" : ""}
            >
              Archive done ({archiveDoneCandidates.length})
            </button>
          )}
        </div>
      </div>

      <div style={{ overflow: "auto" }}>
        <DndContext collisionDetection={closestCenter} onDragEnd={reorderMode ? onDragEnd : undefined}>
          <SortableContext items={reorderMode ? reorderIds : []} strategy={verticalListSortingStrategy}>
            <table>
              <thead>
                <tr>
                  {reorderMode ? <th style={{ width: 46 }} /> : null}
                  <th onClick={() => toggleSort("priority")}>priority</th>
                  <th onClick={() => toggleSort("order")}>order</th>
                  <th onClick={() => toggleSort("__listId")}>list</th>
                  <th onClick={() => toggleSort("status")}>status</th>
                  <th onClick={() => toggleSort("text")}>text</th>
                  <th onClick={() => toggleSort("createdAt")}>createdAt</th>
                  {activeList
                    ? Object.keys(activeList.fields)
                        .filter((k) => !["text", "priority", "color", "order", "status", "archivedAt"].includes(k))
                        .filter((k) => activeList.fields[k]?.ui?.showInPreview !== false)
                        .map((k) => (
                          <th key={k} onClick={() => toggleSort(k)}>
                            {k}
                          </th>
                        ))
                    : null}
                  <th onClick={() => toggleSort("color")}>color</th>
                  <th>actions</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.map((it) => {
                  const isArchived = typeof (it as any).archivedAt === "string" && String((it as any).archivedAt).trim();
                  const draggable =
                    reorderMode && !searchAllLists && it.__listId === listId && (it.priority ?? 3) === reorderPriority;
                  const rowStyle: React.CSSProperties = {
                    background: typeof it.color === "string" && it.color ? hexToRgba(it.color, 0.12) : undefined,
                    opacity: isArchived ? 0.65 : undefined,
                  };

                  if (!reorderMode) {
                    return (
                      <tr key={`${it.__listId}:${it.id}`} style={rowStyle}>
                        <td style={{ minWidth: 92 }}>
                          <select
                            value={String(it.priority ?? 3)}
                            onChange={(e) => setPriority(it.__listId, it.id, Number(e.target.value))}
                          >
                            {[1, 2, 3, 4, 5].map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="small muted" style={{ minWidth: 58 }}>
                          {String(it.order ?? 0)}
                        </td>
                        <td style={{ minWidth: 160 }}>
                          <select value={it.__listId} onChange={(e) => moveRow(it.__listId, e.target.value, it.id)}>
                            {lists.map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.title}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td style={{ minWidth: 160 }}>
                          <StatusPicker
                            value={(it as any).status}
                            archived={Boolean(isArchived)}
                            onChange={(s) => setStatusAny(it.__listId, it.id, s)}
                            onArchive={() => archiveItem(it.__listId, it.id)}
                            onUnarchive={() => unarchiveItem(it.__listId, it.id)}
                          />
                        </td>
                        <td style={{ minWidth: 240 }}>
                          <div>{linkifyText(String(it.text ?? ""))}</div>
                          <div className="small muted">{it.id.slice(0, 12)}</div>
                        </td>
                        <td className="small muted" style={{ minWidth: 150 }}>
                          {new Date(String(it.createdAt)).toLocaleString()}
                        </td>
                        {activeList
                          ? Object.keys(activeList.fields)
                              .filter((k) => !["text", "priority", "color", "order", "status", "archivedAt"].includes(k))
                              .filter((k) => activeList.fields[k]?.ui?.showInPreview !== false)
                              .map((k) => (
                                <td key={k} className="small">
                                  {String((it as any)[k] ?? "")}
                                </td>
                              ))
                          : null}
                        <td style={{ minWidth: 110 }}>
                          <ColorPicker value={it.color as any} onChange={(c) => setColor(it.__listId, it.id, c)} />
                        </td>
                        <td style={{ minWidth: 120 }}>
                          <div className="btnrow">
                            <button className="iconbtn" onClick={() => openEdit(it)} title="Edit" aria-label="Edit">
                              ✎
                            </button>
                            <button
                              className="iconbtn"
                              onClick={() => del(it.__listId, it.id)}
                              title="Delete"
                              aria-label="Delete"
                            >
                              🗑
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <SortableTr
                      key={`${it.__listId}:${it.id}`}
                      id={it.id}
                      disabled={!draggable}
                      style={rowStyle}
                      render={({ dragHandleProps, setDragHandleRef }) => (
                        <>
                          <td style={{ width: 46 }}>
                            {draggable ? (
                              <button
                                className="iconbtn"
                                ref={setDragHandleRef as any}
                                {...dragHandleProps}
                                title="Drag to reorder"
                                aria-label="Drag to reorder"
                              >
                                ↕
                              </button>
                            ) : null}
                          </td>
                          <td style={{ minWidth: 92 }}>
                            <select value={String(it.priority ?? 3)} disabled>
                              {[1, 2, 3, 4, 5].map((p) => (
                                <option key={p} value={p}>
                                  {p}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="small muted" style={{ minWidth: 58 }}>
                            {String(it.order ?? 0)}
                          </td>
                          <td style={{ minWidth: 160 }}>
                            <select value={it.__listId} disabled>
                              {lists.map((l) => (
                                <option key={l.id} value={l.id}>
                                  {l.title}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td style={{ minWidth: 160 }}>
                            <StatusPicker
                              value={(it as any).status}
                              archived={Boolean(isArchived)}
                              onChange={(s) => setStatusAny(it.__listId, it.id, s)}
                              onArchive={() => archiveItem(it.__listId, it.id)}
                              onUnarchive={() => unarchiveItem(it.__listId, it.id)}
                            />
                          </td>
                          <td style={{ minWidth: 240 }}>
                            <div>{linkifyText(String(it.text ?? ""))}</div>
                            <div className="small muted">{it.id.slice(0, 12)}</div>
                          </td>
                          <td className="small muted" style={{ minWidth: 150 }}>
                            {new Date(String(it.createdAt)).toLocaleString()}
                          </td>
                          {activeList
                            ? Object.keys(activeList.fields)
                                .filter((k) => !["text", "priority", "color", "order", "status", "archivedAt"].includes(k))
                                .filter((k) => activeList.fields[k]?.ui?.showInPreview !== false)
                                .map((k) => (
                                  <td key={k} className="small">
                                    {String((it as any)[k] ?? "")}
                                  </td>
                                ))
                            : null}
                          <td style={{ minWidth: 110 }}>
                            <ColorPicker value={it.color as any} onChange={(c) => setColor(it.__listId, it.id, c)} />
                          </td>
                          <td style={{ minWidth: 120 }}>
                            <div className="btnrow">
                              <button className="iconbtn" onClick={() => openEdit(it)} title="Edit" aria-label="Edit">
                                ✎
                              </button>
                              <button
                                className="iconbtn"
                                onClick={() => del(it.__listId, it.id)}
                                title="Delete"
                                aria-label="Delete"
                              >
                                🗑
                              </button>
                            </div>
                          </td>
                        </>
                      )}
                    />
                  );
                })}
                {!busy && displayRows.length === 0 ? (
                  <tr>
                    <td colSpan={50} className="muted small">
                      No items
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </SortableContext>
        </DndContext>
      </div>

      <div style={{ marginTop: 10 }} className="row">
        <div className="col">
          <label className="small muted">Reorder priority bucket</label>
          <select
            value={String(reorderPriority)}
            onChange={(e) => setReorderPriority(Number(e.target.value))}
            disabled={reorderMode}
          >
            {[1, 2, 3, 4, 5].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
        <div className="col">
          <div className="pill small" style={{ marginTop: 18 }}>
            <span className="muted">Sort</span>
            <span>
              {sortKey} ({sortDir})
            </span>
          </div>
        </div>
        <div className="col" style={{ display: "flex", justifyContent: "flex-end", alignItems: "flex-end" }}>
          <div className="btnrow">
            {reorderMode ? (
              <>
                <button className="primary" onClick={commitReorder} disabled={reorderIds.length < 2}>
                  Save reorder
                </button>
                <button onClick={cancelReorder}>Cancel</button>
              </>
            ) : (
              <button
                onClick={beginReorder}
                disabled={searchAllLists || items.filter((it) => (it.priority ?? 3) === reorderPriority).length < 2}
                title={searchAllLists ? "Switch scope to a single list to reorder" : ""}
              >
                Reorder
              </button>
            )}
          </div>
        </div>
      </div>

      {addOpen ? (
        <dialog open className="dialog">
          <div className="topbar" style={{ marginBottom: 8 }}>
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

          <div className="row" style={{ marginBottom: 10 }}>
            <div className="col">
              <label className="small muted">List</label>
              <select value={addListId || ""} onChange={(e) => setAddListId(e.target.value)}>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="col">
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
            <div className="col">
              <label className="small muted">Status</label>
              <div className="row" style={{ alignItems: "center" }}>
                <StatusSelect value={addStatus} onChange={setAddStatus} />
                <div style={{ width: 10 }} />
                <StatusBadge value={addStatus} />
              </div>
            </div>
            <div className="col">
              <label className="small muted">Color</label>
              <ColorSelect value={addColor} onChange={setAddColor} />
            </div>
          </div>

          <div className="row" style={{ alignItems: "center", justifyContent: "space-between" }}>
            <label className="small muted">Text *</label>
            <button
              className="iconbtn"
              onClick={addListening ? stopAddMic : startAddMic}
              disabled={!SR}
              title={!SR ? "SpeechRecognition not supported in this browser" : ""}
              data-mic="add"
            >
              {addListening ? "Stop 🎙" : "Mic 🎙"}
            </button>
          </div>
          <textarea value={String(addFields.text ?? "")} onChange={(e) => setAddField("text", e.target.value)} />

          {activeAddList() ? (
            <div style={{ marginTop: 10 }}>
              <div className="muted small" style={{ marginBottom: 6 }}>
                Extra fields
              </div>
              <div className="row" style={{ flexWrap: "wrap" }}>
                {Object.entries(activeAddList()!.fields)
                  .filter(([name]) => !["text", "priority", "color", "order", "status"].includes(name))
                  .map(([name, def]) => renderAddFieldInput(activeAddList()!, name, def))}
              </div>
            </div>
          ) : null}

          <div style={{ marginTop: 12 }} className="btnrow">
            <button className="primary" onClick={submitAdd} disabled={Boolean(validateAddForm())}>
              Add
            </button>
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
      ) : null}

      {editOpen && editRow ? (
        <dialog open className="dialog">
          <div className="topbar" style={{ marginBottom: 8 }}>
            <div>
              <div className="title">Edit item</div>
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
            onChange={(e) => {
              setEditDraft(e.target.value);
              setEditErr(null);
            }}
          />
          <div style={{ marginTop: 10 }} className="btnrow">
            <button
              className="primary"
              onClick={confirmEdit}
              disabled={!editDraft.trim() || editDraft === editOriginalDraft}
              title={editDraft === editOriginalDraft ? "No changes" : ""}
            >
              Save
            </button>
            <button
              className="danger"
              onClick={() => {
                setEditOpen(false);
                setEditRow(null);
                setEditDraft("");
                setEditOriginalDraft("");
                setEditErr(null);
              }}
            >
              Cancel
            </button>
          </div>
          {editErr ? (
            <div style={{ marginTop: 10 }} className="error small">
              {editErr}
            </div>
          ) : null}
        </dialog>
      ) : null}

      {err ? (
        <div style={{ marginTop: 10 }} className="error small">
          {err}
        </div>
      ) : null}
    </div>
  );
}
