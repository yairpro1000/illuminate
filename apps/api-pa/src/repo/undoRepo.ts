import type { Db } from "./supabase";

export type UndoSnapshot = {
  listId: string;
  action: "delete_item" | "update_item" | "move_item";
  item: Record<string, unknown> & { id: string };
  patchedFields?: string[]; // update_item only: which fields to restore on undo
  movedToListId?: string; // move_item only: the list the item was moved to
};

export type UndoLogEntry = {
  id: string;
  userId: string;
  label: string;
  snapshots: UndoSnapshot[];
  createdAt: string;
};

export type UndoLogEntryLight = {
  id: string;
  label: string;
  itemCount: number;
  listIds: string[];
  createdAt: string;
};

const UNDO_LIMIT = 500;

export function makeUndoRepo(db: Db) {
  return {
    async push(entry: Omit<UndoLogEntry, "createdAt">): Promise<void> {
      const { error } = await db.from("pa_undo_log").insert({
        id: entry.id,
        user_id: entry.userId,
        label: entry.label,
        snapshots: entry.snapshots,
      });
      if (error) throw error;
      await this.trimToLimit(entry.userId);
    },

    async trimToLimit(userId: string): Promise<void> {
      const { data: overflow, error: ovErr } = await db
        .from("pa_undo_log")
        .select("id,user_id,label,snapshots,created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .range(UNDO_LIMIT, UNDO_LIMIT + 9999);
      if (ovErr) throw ovErr;
      if (!overflow || overflow.length === 0) return;

      const historyRows = (overflow as any[]).map((row) => ({
        id: row.id,
        user_id: row.user_id,
        label: row.label,
        snapshots: row.snapshots,
        created_at: row.created_at,
      }));
      const { error: histErr } = await db
        .from("pa_undo_log_history")
        .upsert(historyRows, { onConflict: "id" });
      if (histErr) throw histErr;

      const ids = (overflow as any[]).map((row) => row.id);
      const { error: delErr } = await db.from("pa_undo_log").delete().eq("user_id", userId).in("id", ids);
      if (delErr) throw delErr;
    },

    async list(userId: string): Promise<UndoLogEntryLight[]> {
      const { data, error } = await db
        .from("pa_undo_log")
        .select("id,label,snapshots,created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as any[]).map((row) => {
        const snapshots: UndoSnapshot[] = Array.isArray(row.snapshots) ? row.snapshots : [];
        return {
          id: row.id,
          label: row.label,
          createdAt: row.created_at,
          itemCount: snapshots.length,
          listIds: Array.from(new Set(snapshots.map((s) => s.listId))),
        };
      });
    },

    async get(id: string, userId: string): Promise<UndoLogEntry | null> {
      const { data, error } = await db
        .from("pa_undo_log")
        .select("id,user_id,label,snapshots,created_at")
        .eq("id", id)
        .eq("user_id", userId)
        .limit(1);
      if (error) throw error;
      const row = (data as any)?.[0];
      if (!row) return null;
      return {
        id: row.id,
        userId: row.user_id,
        label: row.label,
        snapshots: row.snapshots as UndoSnapshot[],
        createdAt: row.created_at,
      };
    },

    // Returns later entries (created_at > targetCreatedAt) that share any item ID
    // with the target. Fetches all later entries and filters in JS (max 500 rows).
    async findConflicts(
      targetCreatedAt: string,
      targetId: string,
      itemIds: string[],
      userId: string,
    ): Promise<UndoLogEntryLight[]> {
      const { data, error } = await db
        .from("pa_undo_log")
        .select("id,label,snapshots,created_at")
        .eq("user_id", userId)
        .gt("created_at", targetCreatedAt);
      if (error) throw error;

      const itemIdSet = new Set(itemIds);
      return ((data ?? []) as any[])
        .filter(
          (row) =>
            row.id !== targetId &&
            Array.isArray(row.snapshots) &&
            (row.snapshots as UndoSnapshot[]).some((s) => itemIdSet.has(s.item.id)),
        )
        .map((row) => {
          const snapshots: UndoSnapshot[] = row.snapshots;
          return {
            id: row.id,
            label: row.label,
            createdAt: row.created_at,
            itemCount: snapshots.length,
            listIds: Array.from(new Set(snapshots.map((s) => s.listId))),
          };
        });
    },

    // Removes snapshots whose item.id is in itemIds from the entry.
    // Deletes the entry entirely if it becomes empty.
    async removeItemsFromEntry(entryId: string, itemIds: string[], userId: string): Promise<void> {
      const { data, error } = await db
        .from("pa_undo_log")
        .select("id,snapshots")
        .eq("user_id", userId)
        .eq("id", entryId)
        .limit(1);
      if (error) throw error;
      const row = (data as any)?.[0];
      if (!row) return;

      const idSet = new Set(itemIds);
      const filtered = (row.snapshots as UndoSnapshot[]).filter((s) => !idSet.has(s.item.id));

      if (filtered.length === 0) {
        const { error: delErr } = await db.from("pa_undo_log").delete().eq("user_id", userId).eq("id", entryId);
        if (delErr) throw delErr;
      } else {
        const { error: updErr } = await db
          .from("pa_undo_log")
          .update({ snapshots: filtered })
          .eq("user_id", userId)
          .eq("id", entryId);
        if (updErr) throw updErr;
      }
    },

    async delete(id: string, userId: string): Promise<void> {
      const { error } = await db
        .from("pa_undo_log")
        .delete()
        .eq("id", id)
        .eq("user_id", userId);
      if (error) throw error;
    },
  };
}

export type UndoRepo = ReturnType<typeof makeUndoRepo>;
