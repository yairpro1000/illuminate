import React from "react";
import type { ItemRow } from "./types";
import type { StatusValue } from "./constants";

export function useBulkActions(args: {
  displayRows: ItemRow[];
  searchAllLists: boolean;
  listId: string;
  loadAllRows: () => Promise<void>;
  loadItems: (listId: string) => Promise<void>;
  setBusy: (value: boolean) => void;
  setErr: (value: string | null) => void;
  commit: (action: any, opts?: { refresh?: boolean; expectedItemUpdatedAt?: string; undoLabel?: string }) => Promise<any>;
  getItemUpdatedAt: (targetListId: string, itemId: string) => string | undefined;
  ensureStatusField: (listId: string) => Promise<void>;
  ensureArchivedField: (listId: string) => Promise<void>;
}) {
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());

  const selectedRows = React.useMemo(
    () => args.displayRows.filter((r) => selectedIds.has(r.id)),
    [args.displayRows, selectedIds],
  );
  const selectedArchivedCount = React.useMemo(
    () =>
      selectedRows.filter((row) => {
        const archivedAt = (row as any).archivedAt;
        return (typeof archivedAt === "string" && String(archivedAt).trim()) || archivedAt === true;
      }).length,
    [selectedRows],
  );

  const refreshScope = React.useCallback(async () => {
    if (args.searchAllLists) await args.loadAllRows();
    else await args.loadItems(args.listId);
  }, [args]);

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size > 0) setSelectedIds(new Set());
    else setSelectedIds(new Set(args.displayRows.map((r) => r.id)));
  }

  async function deleteSelected() {
    if (selectedIds.size === 0) return;
    const confirmed = window.confirm(`Delete ${selectedIds.size} item${selectedIds.size !== 1 ? "s" : ""}?`);
    if (!confirmed) return;
    args.setBusy(true);
    args.setErr(null);
    try {
      const rows = args.displayRows.filter((r) => selectedIds.has(r.id));
      const label = `Deleted ${rows.length} item${rows.length !== 1 ? "s" : ""}`;
      await args.commit({
        type: "batch",
        valid: true,
        confidence: 1,
        label,
        actions: rows.map((r) => ({ type: "delete_item", listId: r.__listId, itemId: r.id })),
      }, { undoLabel: label });
      setSelectedIds(new Set());
    } catch (e: any) {
      args.setErr(String(e?.message ?? e));
    } finally {
      args.setBusy(false);
    }
  }

  async function bulkUpdate(patch: Record<string, unknown>) {
    if (selectedIds.size === 0) return;
    args.setBusy(true);
    args.setErr(null);
    try {
      for (const id of selectedIds) {
        const row = args.displayRows.find((r) => r.id === id);
        if (!row) continue;
        await args.commit(
          { type: "update_item", valid: true, confidence: 1, listId: row.__listId, itemId: id, patch },
          { refresh: false, expectedItemUpdatedAt: args.getItemUpdatedAt(row.__listId, id) },
        );
      }
      setSelectedIds(new Set());
      await refreshScope();
    } catch (e: any) {
      args.setErr(String(e?.message ?? e));
    } finally {
      args.setBusy(false);
    }
  }

  async function bulkMove(toListId: string) {
    if (selectedIds.size === 0 || !toListId) return;
    args.setBusy(true);
    args.setErr(null);
    try {
      for (const id of selectedIds) {
        const row = args.displayRows.find((r) => r.id === id);
        if (!row || row.__listId === toListId) continue;
        await args.commit(
          { type: "move_item", valid: true, confidence: 1, fromListId: row.__listId, toListId, itemId: id },
          { refresh: false, undoLabel: "Moved item" },
        );
      }
      setSelectedIds(new Set());
      await refreshScope();
    } catch (e: any) {
      args.setErr(String(e?.message ?? e));
    } finally {
      args.setBusy(false);
    }
  }

  async function bulkSetStatus(status: StatusValue) {
    if (selectedIds.size === 0) return;
    args.setBusy(true);
    args.setErr(null);
    try {
      const affectedListIds = Array.from(new Set(
        args.displayRows.filter((r) => selectedIds.has(r.id)).map((r) => r.__listId),
      ));
      for (const lid of affectedListIds) await args.ensureStatusField(lid);
      for (const id of selectedIds) {
        const row = args.displayRows.find((r) => r.id === id);
        if (!row) continue;
        await args.commit(
          { type: "update_item", valid: true, confidence: 1, listId: row.__listId, itemId: id, patch: { status } },
          { refresh: false, expectedItemUpdatedAt: args.getItemUpdatedAt(row.__listId, id) },
        );
      }
      setSelectedIds(new Set());
      await refreshScope();
    } catch (e: any) {
      args.setErr(String(e?.message ?? e));
    } finally {
      args.setBusy(false);
    }
  }

  async function bulkArchiveSelected() {
    if (selectedRows.length === 0) return;
    args.setBusy(true);
    args.setErr(null);
    try {
      const now = new Date().toISOString();
      const listIds = Array.from(new Set(selectedRows.map((r) => r.__listId)));
      for (const lid of listIds) await args.ensureArchivedField(lid);
      for (const row of selectedRows) {
        await args.commit(
          {
            type: "update_item",
            valid: true,
            confidence: 1,
            listId: row.__listId,
            itemId: row.id,
            patch: { archivedAt: now },
          },
          { refresh: false, expectedItemUpdatedAt: args.getItemUpdatedAt(row.__listId, row.id) },
        );
      }
      setSelectedIds(new Set());
      await refreshScope();
    } catch (e: any) {
      args.setErr(String(e?.message ?? e));
    } finally {
      args.setBusy(false);
    }
  }

  async function bulkUnarchiveSelected() {
    if (selectedRows.length === 0) return;
    args.setBusy(true);
    args.setErr(null);
    try {
      const listIds = Array.from(new Set(selectedRows.map((r) => r.__listId)));
      for (const lid of listIds) await args.ensureArchivedField(lid);
      for (const row of selectedRows) {
        await args.commit(
          {
            type: "update_item",
            valid: true,
            confidence: 1,
            listId: row.__listId,
            itemId: row.id,
            patch: { archivedAt: null },
          },
          { refresh: false, expectedItemUpdatedAt: args.getItemUpdatedAt(row.__listId, row.id) },
        );
      }
      setSelectedIds(new Set());
      await refreshScope();
    } catch (e: any) {
      args.setErr(String(e?.message ?? e));
    } finally {
      args.setBusy(false);
    }
  }

  return {
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
  };
}
