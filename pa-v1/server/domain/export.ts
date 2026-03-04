import ExcelJS from "exceljs";
import type { ListItem, SchemaRegistry } from "../../shared/model";
import { resolveListId } from "../storage/schema";
import { readListItems } from "./lists";

function excelArgbFromHexColor(color: unknown, alphaHex = "33") {
  if (typeof color !== "string") return null;
  const h = color.trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  // ExcelJS uses ARGB (alpha + RGB). Alpha "33" ~ 20% for a subtle row tint.
  return `${alphaHex}${h}`.toUpperCase();
}

function csvEscape(value: unknown) {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (/[,"\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

export async function exportListCsv(schema: SchemaRegistry, listId: string) {
  const resolved = resolveListId(schema, { listId });
  const def = schema.lists[resolved];
  if (!def) throw new Error(`List "${listId}" not found.`);
  const items = await readListItems(schema, resolved);

  const fieldNames = Object.keys(def.fields);
  const headers = ["id", "createdAt", ...fieldNames];

  const lines: string[] = [];
  lines.push(headers.join(","));
  for (const it of items) {
    const row = headers.map((h) => csvEscape((it as Record<string, unknown>)[h]));
    lines.push(row.join(","));
  }
  return lines.join("\n") + "\n";
}

export async function exportListXlsx(schema: SchemaRegistry, listId: string) {
  const resolved = resolveListId(schema, { listId });
  const def = schema.lists[resolved];
  if (!def) throw new Error(`List "${listId}" not found.`);
  const items = await readListItems(schema, resolved);
  const fieldNames = Object.keys(def.fields);
  const headers = ["id", "createdAt", ...fieldNames];

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(def.title);
  ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(12, h.length + 2) }));

  for (const it of items) {
    const row: Record<string, unknown> = {};
    for (const h of headers) row[h] = (it as Record<string, unknown>)[h] ?? "";
    const added = ws.addRow(row);
    const rowArgb = excelArgbFromHexColor((it as any).color);
    if (rowArgb) {
      const fill: ExcelJS.Fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: rowArgb },
      };
      for (let i = 1; i <= headers.length; i++) {
        added.getCell(i).fill = fill;
      }
    }
  }

  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.getRow(1).font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

export function normalizeItemsForUi(items: ListItem[]) {
  // Keep ordering stable by default; UI can resort.
  return items.map((it) => ({
    ...it,
    priority: typeof it.priority === "number" ? it.priority : 3,
    order: typeof it.order === "number" ? it.order : 0,
  }));
}
