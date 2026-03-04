import type { ListItem } from "../../shared/model";

export function isUuidLike(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}

export function isItemIdLike(value: string) {
  const v = value.trim();
  if (!v) return false;
  if (isUuidLike(v)) return true;
  // Allow legacy / seeded ids (local-only app); keep it conservative.
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v);
}

export function itemExists(items: ListItem[], id: string) {
  return items.some((it) => it.id === id);
}
