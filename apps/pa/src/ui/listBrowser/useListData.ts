import React from "react";
import type { ListItem } from "@shared/model";
import { api } from "../../api";
import type { ItemRow, ListInfo } from "./types";

function sortLists(lists: ListInfo[]) {
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
}

export function useListData(props: { refreshSignal: number; searchAllLists: boolean }) {
  const [lists, setLists] = React.useState<ListInfo[]>([]);
  const [listId, setListId] = React.useState<string>("");
  const [items, setItems] = React.useState<ListItem[]>([]);
  const [searchRows, setSearchRows] = React.useState<ItemRow[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [stale, setStale] = React.useState<{ current: number; db: number } | null>(null);

  const loadLists = React.useCallback(async () => {
    setErr(null);
    const data = await api<{ lists: ListInfo[] }>("/lists", { method: "GET" });
    setLists(data.lists);
    setStale(null);
    setListId((current) => {
      if (current) return current;
      return data.lists.find((l) => String(l.title).toLowerCase() === "translate")?.id
        ?? data.lists.find((l) => l.id === "app")?.id
        ?? data.lists[0]?.id
        ?? "";
    });
  }, []);

  const loadItems = React.useCallback(async (id: string) => {
    if (!id) return;
    setBusy(true);
    setErr(null);
    try {
      const data = await api<{ items: ListItem[] }>(`/lists/${encodeURIComponent(id)}/items`, { method: "GET" });
      setItems(data.items);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, []);

  const loadAllRows = React.useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const data = await api<{ rows: Array<ListItem & { listId: string }> }>("/lists/items", { method: "GET" });
      setSearchRows((data.rows ?? []).map((row) => ({ ...(row as any), __listId: String(row.listId ?? "") }) as ItemRow));
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    void loadLists().catch((e) => setErr(String(e?.message ?? e)));
  }, [loadLists]);

  React.useEffect(() => {
    void loadLists().catch(() => {});
  }, [loadLists, props.refreshSignal]);

  React.useEffect(() => {
    if (!listId || props.searchAllLists) return;
    setSearchRows(null);
    void loadItems(listId);
  }, [listId, props.refreshSignal, props.searchAllLists, loadItems]);

  React.useEffect(() => {
    if (!props.searchAllLists || lists.length === 0) return;
    void loadAllRows();
  }, [props.searchAllLists, props.refreshSignal, lists.length, loadAllRows]);

  const sortedLists = React.useMemo(() => sortLists(lists), [lists]);
  const activeList = lists.find((l) => l.id === listId) ?? null;

  React.useEffect(() => {
    if (!listId || !activeList) return;
    let cancelled = false;
    const activeRevision = activeList.meta?.revision;

    async function poll() {
      try {
        const data = await api<{ lists: ListInfo[] }>("/lists", { method: "GET" });
        if (cancelled) return;
        const dbRev = data.lists.find((l) => l.id === listId)?.meta?.revision;
        if (typeof dbRev === "number" && typeof activeRevision === "number" && dbRev !== activeRevision) {
          setStale({ current: activeRevision, db: dbRev });
        }
      } catch {
        // ignore
      }
    }

    void poll();
    const handle = window.setInterval(poll, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [listId, activeList]);

  return {
    lists,
    setLists,
    listId,
    setListId,
    items,
    setItems,
    searchRows,
    setSearchRows,
    busy,
    setBusy,
    err,
    setErr,
    stale,
    setStale,
    sortedLists,
    activeList,
    loadLists,
    loadItems,
    loadAllRows,
  };
}
