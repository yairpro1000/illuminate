import type { PersistedListFilterPriority, PersistedListViewState, PersistedListViewStateEnvelope } from "./types";
import type { SortLayer } from "./utils";

const STORAGE_PREFIX = "pa:list-browser:view:";
const VIEW_STATE_VERSION = 1 as const;

const DEFAULT_SORT_LAYERS: SortLayer[] = [{ key: "createdAt", dir: "desc" }];

export const DEFAULT_PERSISTED_LIST_VIEW_STATE: PersistedListViewState = {
  filterText: "",
  filterPriority: "",
  filterColor: "",
  filterTopic: "",
  showArchived: false,
  sortLayers: DEFAULT_SORT_LAYERS,
};

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isPersistableListId(listId: string): boolean {
  return String(listId ?? "").trim().length > 0;
}

function storageKey(listId: string): string | null {
  if (!isPersistableListId(listId)) return null;
  return `${STORAGE_PREFIX}${encodeURIComponent(String(listId).trim())}`;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizePriority(value: unknown): PersistedListFilterPriority {
  return typeof value === "number" && Number.isFinite(value) ? value : "";
}

function normalizeSortLayer(value: unknown): SortLayer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const key = typeof (value as { key?: unknown }).key === "string"
    ? (value as { key: string }).key.trim()
    : "";
  const dir = (value as { dir?: unknown }).dir;
  if (!key) return null;
  if (dir !== "asc" && dir !== "desc") return null;
  return { key, dir };
}

function normalizeSortLayers(value: unknown): SortLayer[] {
  if (!Array.isArray(value)) return DEFAULT_PERSISTED_LIST_VIEW_STATE.sortLayers;
  const normalized = value
    .map((entry) => normalizeSortLayer(entry))
    .filter((entry): entry is SortLayer => entry !== null);
  return normalized.length > 0 ? normalized : DEFAULT_PERSISTED_LIST_VIEW_STATE.sortLayers;
}

export function normalizeListViewState(value: unknown): PersistedListViewState {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<PersistedListViewState>
    : {};
  return {
    filterText: normalizeText(candidate.filterText),
    filterPriority: normalizePriority(candidate.filterPriority),
    filterColor: normalizeText(candidate.filterColor),
    filterTopic: normalizeText(candidate.filterTopic),
    showArchived: Boolean(candidate.showArchived),
    sortLayers: normalizeSortLayers(candidate.sortLayers),
  };
}

function readEnvelope(listId: string): PersistedListViewStateEnvelope | null {
  const key = storageKey(listId);
  const storage = safeStorage();
  if (!key || !storage) return null;
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedListViewStateEnvelope>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (parsed.version !== VIEW_STATE_VERSION) return null;
    return {
      version: VIEW_STATE_VERSION,
      state: normalizeListViewState(parsed.state),
    };
  } catch {
    return null;
  }
}

export function loadListViewState(listId: string): PersistedListViewState {
  return readEnvelope(listId)?.state ?? DEFAULT_PERSISTED_LIST_VIEW_STATE;
}

export function saveListViewState(listId: string, state: PersistedListViewState): void {
  const key = storageKey(listId);
  const storage = safeStorage();
  if (!key || !storage) return;
  const envelope: PersistedListViewStateEnvelope = {
    version: VIEW_STATE_VERSION,
    state: normalizeListViewState(state),
  };
  storage.setItem(key, JSON.stringify(envelope));
}

export function clearListViewState(listId: string): void {
  const key = storageKey(listId);
  const storage = safeStorage();
  if (!key || !storage) return;
  storage.removeItem(key);
}

export function shouldPersistListViewState(input: {
  listId: string;
  hydratedListId: string;
  searchAllLists: boolean;
  reorderMode: boolean;
}): boolean {
  if (input.searchAllLists) return false;
  if (input.reorderMode) return false;
  if (!isPersistableListId(input.listId)) return false;
  return input.hydratedListId === input.listId;
}
