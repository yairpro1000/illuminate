import type { FieldDef, ListDef, ListItem } from "../shared/model";

export const reservedItemKeys = new Set(["id", "createdAt"]);

function coerceToInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Math.trunc(Number(value));
  return null;
}

function coerceToFloat(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function coerceToBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(v)) return true;
    if (["false", "no", "n", "0"].includes(v)) return false;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return null;
}

function coerceToDateIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function coerceToTimeString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  if (/^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d{1,3})?)?$/.test(v)) return v;
  return null;
}

export function coerceFieldValue(fieldName: string, def: FieldDef, value: unknown): unknown {
  if (value === undefined) return undefined;

  if (value === null) {
    if (def.nullable) return null;
    throw new Error(`Field "${fieldName}" cannot be null.`);
  }

  switch (def.type) {
    case "string":
      return typeof value === "string" ? value : String(value);
    case "int": {
      const v = coerceToInt(value);
      if (v === null) throw new Error(`Field "${fieldName}" must be an int.`);
      return v;
    }
    case "float": {
      const v = coerceToFloat(value);
      if (v === null) throw new Error(`Field "${fieldName}" must be a number.`);
      return v;
    }
    case "boolean": {
      const v = coerceToBoolean(value);
      if (v === null) throw new Error(`Field "${fieldName}" must be a boolean.`);
      return v;
    }
    case "date": {
      const v = coerceToDateIso(value);
      if (v === null) throw new Error(`Field "${fieldName}" must be a date string.`);
      return v;
    }
    case "time": {
      const v = coerceToTimeString(value);
      if (v === null) throw new Error(`Field "${fieldName}" must be a time string (HH:MM[:SS[.sss]]).`);
      return v;
    }
    case "json":
      return value;
    default:
      throw new Error(`Unsupported field type for "${fieldName}".`);
  }
}

export function applyDefaultsForCreate(listDef: ListDef, input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};

  const allowedKeys = new Set(Object.keys(listDef.fields));
  for (const k of Object.keys(input)) {
    if (reservedItemKeys.has(k)) continue;
    if (!allowedKeys.has(k)) throw new Error(`Unknown field "${k}" for list "${listDef.title}".`);
  }

  for (const [fieldName, def] of Object.entries(listDef.fields)) {
    const hasValue = Object.prototype.hasOwnProperty.call(input, fieldName);
    const value = hasValue ? input[fieldName] : undefined;
    if (value === undefined) {
      if (Object.prototype.hasOwnProperty.call(def, "default")) out[fieldName] = def.default;
      else if (def.nullable) out[fieldName] = null;
      else throw new Error(`Missing required field "${fieldName}".`);
      continue;
    }
    out[fieldName] = coerceFieldValue(fieldName, def, value);
  }

  return out;
}

export function validatePatch(listDef: ListDef, patch: Record<string, unknown>) {
  const allowedKeys = new Set(Object.keys(listDef.fields));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (reservedItemKeys.has(k)) throw new Error(`Field "${k}" is not editable.`);
    if (!allowedKeys.has(k)) throw new Error(`Unknown field "${k}" for list "${listDef.title}".`);
    out[k] = coerceFieldValue(k, listDef.fields[k]!, v);
  }
  return out;
}

export function migrateAddMissingFields(
  listDef: ListDef,
  item: ListItem,
  fieldsToAdd: Array<{ name: string; def: FieldDef }>,
) {
  const next = { ...item } as Record<string, unknown>;
  for (const { name, def } of fieldsToAdd) {
    if (Object.prototype.hasOwnProperty.call(next, name)) continue;
    if (Object.prototype.hasOwnProperty.call(def, "default")) next[name] = def.default;
    else if (def.nullable) next[name] = null;
    else throw new Error(`Cannot migrate: new field "${name}" is required but has no default.`);
  }
  return next as ListItem;
}

