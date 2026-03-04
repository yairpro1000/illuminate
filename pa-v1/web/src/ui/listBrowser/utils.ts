import React from "react";

export function bySortKey(key: string, dir: "asc" | "desc") {
  return (a: any, b: any) => {
    const av = a?.[key];
    const bv = b?.[key];
    if (av === bv) return 0;
    if (av === undefined || av === null) return dir === "asc" ? 1 : -1;
    if (bv === undefined || bv === null) return dir === "asc" ? -1 : 1;
    if (typeof av === "number" && typeof bv === "number") return dir === "asc" ? av - bv : bv - av;
    return dir === "asc"
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av));
  };
}

export function fieldLabel(name: string) {
  if (name === "createdAt") return "Created";
  if (name === "listId") return "List";
  if (name === "in_progress") return "In progress";
  return name.replaceAll(/_/g, " ");
}

export function moveArrayItem<T>(arr: T[], from: number, to: number) {
  const next = arr.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function splitTrailingPunct(raw: string) {
  let token = raw;
  let trailing = "";
  while (token.length > 0 && /[)\].,;:!?]$/.test(token)) {
    trailing = token.slice(-1) + trailing;
    token = token.slice(0, -1);
  }
  return { token, trailing };
}

function normalizeTel(raw: string) {
  return raw.replace(/[^\d+]/g, "");
}

function countDigits(raw: string) {
  const m = raw.match(/\d/g);
  return m ? m.length : 0;
}

export function linkifyText(text: string): React.ReactNode {
  const t = String(text ?? "");
  if (!t.trim()) return t;

  const re =
    /\b(https?:\/\/[^\s<]+|www\.[^\s<]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\+?\d[\d\s().-]{7,}\d)\b/gi;

  const out: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(t))) {
    const start = match.index;
    const raw = match[0] ?? "";
    if (start > lastIndex) out.push(t.slice(lastIndex, start));

    const { token, trailing } = splitTrailingPunct(raw);
    const lower = token.toLowerCase();

    const isEmail = token.includes("@") && !lower.startsWith("http") && !lower.startsWith("www.");
    const isUrl = lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("www.");
    const isPhone = !isEmail && !isUrl && countDigits(token) >= 8;

    if (isUrl) {
      const href = lower.startsWith("http") ? token : `https://${token}`;
      out.push(
        React.createElement(
          "a",
          { key: `${start}:${token}`, href, target: "_blank", rel: "noreferrer" },
          token,
        ),
      );
    } else if (isEmail) {
      out.push(
        React.createElement("a", { key: `${start}:${token}`, href: `mailto:${token}` }, token),
      );
    } else if (isPhone) {
      const tel = normalizeTel(token);
      out.push(
        React.createElement("a", { key: `${start}:${token}`, href: `tel:${tel}` }, token),
      );
    } else {
      out.push(token);
    }

    if (trailing) out.push(trailing);
    lastIndex = start + raw.length;
  }
  if (lastIndex < t.length) out.push(t.slice(lastIndex));
  return out;
}

export function hexToRgba(hex: string, alpha: number) {
  const h = hex.trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return `rgba(0,0,0,0)`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
