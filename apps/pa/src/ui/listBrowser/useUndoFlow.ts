import React from "react";
import { api } from "../../api";

type UndoLogEntryLight = {
  id: string;
  label: string;
  itemCount: number;
  listIds: string[];
  createdAt: string;
};

type UndoToast = { id: string; label: string; timerId: number };
type UndoConfirm = { ids: string[] };

export function useUndoFlow(args: {
  loadLists: () => Promise<any>;
  loadAllRows: () => Promise<any>;
  loadItems: (listId: string) => Promise<any>;
  listId: string;
  searchAllLists: boolean;
  setErr: React.Dispatch<React.SetStateAction<string | null>>;
  setStale: React.Dispatch<React.SetStateAction<{ current: number; db: number } | null>>;
}) {
  const { loadLists, loadAllRows, loadItems, listId, searchAllLists, setErr, setStale } = args;
  const [undoMode, setUndoMode] = React.useState(false);
  const [undoLog, setUndoLog] = React.useState<UndoLogEntryLight[]>([]);
  const [undoSelectedIds, setUndoSelectedIds] = React.useState<Set<string>>(new Set());
  const [undoToast, setUndoToast] = React.useState<UndoToast | null>(null);
  const [undoConfirm, setUndoConfirm] = React.useState<UndoConfirm | null>(null);
  const [undoBusy, setUndoBusy] = React.useState(false);

  const showUndoToast = React.useCallback((id: string, label: string) => {
    setUndoToast((prev) => {
      if (prev?.timerId) window.clearTimeout(prev.timerId);
      const timerId = window.setTimeout(() => setUndoToast(null), 7000);
      return { id, label, timerId };
    });
  }, []);

  const dismissUndoToast = React.useCallback(() => {
    setUndoToast((prev) => {
      if (prev?.timerId) window.clearTimeout(prev.timerId);
      return null;
    });
  }, []);

  const loadUndoLog = React.useCallback(async () => {
    const res = await api<{ entries: UndoLogEntryLight[] }>("/undo");
    setUndoLog(res.entries);
  }, []);

  const enterUndoMode = React.useCallback(async () => {
    setErr(null);
    setUndoSelectedIds(new Set());
    try {
      await loadUndoLog();
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
    setUndoMode(true);
  }, [loadUndoLog, setErr]);

  const exitUndoMode = React.useCallback(() => {
    setUndoMode(false);
    setUndoSelectedIds(new Set());
  }, []);

  const toggleUndoSelect = React.useCallback((id: string) => {
    setUndoSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const executeUndo = React.useCallback(async (ids: string[], confirmed: boolean) => {
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
  }, [dismissUndoToast, listId, loadAllRows, loadItems, loadLists, loadUndoLog, searchAllLists, setErr, setStale, undoMode]);

  return {
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
  };
}
