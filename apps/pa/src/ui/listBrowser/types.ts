import type { FieldDef, ListItem } from "@shared/model";

export type ListInfo = {
  id: string;
  title: string;
  description: string;
  aliases: string[];
  fields: Record<string, FieldDef>;
  meta: { revision: number; itemsUpdatedAt: string; itemsUpdatedBy: string | null };
};

export type ItemRow = ListItem & { __listId: string };
