import type { ListItem } from "@shared/model";
import type { ItemRow } from "./types";
import { byMultiSort, type SortLayer } from "./utils";

export function findItemUpdatedAt(input: {
  targetListId: string;
  itemId: string;
  searchAllLists: boolean;
  searchRows: ItemRow[] | null;
  listId: string;
  items: ListItem[];
}): string | undefined {
  if (!input.itemId) return undefined;
  if (input.searchAllLists) {
    const row = input.searchRows?.find((r) => r.__listId === input.targetListId && r.id === input.itemId) ?? null;
    const value = (row as any)?.updatedAt;
    return typeof value === "string" ? value : undefined;
  }
  if (input.targetListId !== input.listId) return undefined;
  const row = input.items.find((it: any) => it.id === input.itemId) as any;
  const value = row?.updatedAt;
  return typeof value === "string" ? value : undefined;
}

export function buildVisibleRows(input: {
  searchAllLists: boolean;
  searchRows: ItemRow[] | null;
  items: ListItem[];
  listId: string;
  filterText: string;
  filterPriority: number | "";
  filterColor: string | "";
  filterTopic: string;
  showArchived: boolean;
}): ItemRow[] {
  return (input.searchAllLists && input.searchRows
    ? input.searchRows
    : input.items.map((it) => ({ ...(it as any), __listId: input.listId }) as ItemRow)
  ).filter((it) => {
    const txt = String(it.text ?? "");
    if (input.filterText.trim() && !txt.toLowerCase().includes(input.filterText.trim().toLowerCase())) return false;
    if (input.filterPriority !== "" && (it.priority ?? 3) !== input.filterPriority) return false;
    if (input.filterColor !== "" && String(it.color ?? "").toLowerCase() !== String(input.filterColor).toLowerCase()) return false;
    if (input.filterTopic.trim() && String((it as any).topic ?? "").toLowerCase() !== input.filterTopic.trim().toLowerCase()) return false;
    if (!input.showArchived) {
      const archivedAt = (it as any).archivedAt;
      if ((typeof archivedAt === "string" && archivedAt.trim()) || archivedAt === true) return false;
    }
    return true;
  });
}

export function buildDisplayRows(input: {
  visibleRows: ItemRow[];
  sortLayers: SortLayer[];
  reorderMode: boolean;
  reorderIds: string[];
}): { filtered: ItemRow[]; displayRows: ItemRow[] } {
  const filtered = [...input.visibleRows].sort(byMultiSort(input.sortLayers));
  if (!input.reorderMode) return { filtered, displayRows: filtered };
  const filteredById = new Map(filtered.map((r) => [r.id, r]));
  return {
    filtered,
    displayRows: input.reorderIds.map((id) => filteredById.get(id)).filter(Boolean) as ItemRow[],
  };
}

export function buildTopics(visibleRows: ItemRow[]): string[] {
  return Array.from(
    new Set(
      visibleRows
        .map((it) => String((it as any).topic ?? "").trim())
        .filter((t) => t.length > 0),
    ),
  ).sort((a, b) => a.localeCompare(b));
}
