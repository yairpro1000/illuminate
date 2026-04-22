import type { FieldDef, ListItem } from "@shared/model";
import type { SortLayer } from "./utils";

export type ListInfo = {
  id: string;
  title: string;
  description: string;
  aliases: string[];
  fields: Record<string, FieldDef>;
  meta: { revision: number; itemsUpdatedAt: string; itemsUpdatedBy: string | null };
};

export type ItemRow = ListItem & { __listId: string };

export type PersistedListFilterPriority = number | "";

export interface PersistedListViewState {
  filterText: string;
  filterPriority: PersistedListFilterPriority;
  filterColor: string | "";
  filterTopic: string;
  showArchived: boolean;
  sortLayers: SortLayer[];
}

export interface PersistedListViewStateEnvelope {
  version: 1;
  state: PersistedListViewState;
}
