const API_BASE = (import.meta as any).env?.VITE_API_BASE ?? "";

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const fullUrl = url.startsWith("http") ? url : `${API_BASE}${url}`;
  const res = await fetch(fullUrl, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    credentials: "include",
  });

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const details =
      typeof body === "string"
        ? body
        : typeof (body as any)?.details === "string"
          ? (body as any).details
          : JSON.stringify(body);
    throw new Error(details || `HTTP ${res.status}`);
  }

  return body as T;
}

