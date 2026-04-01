/**
 * Minimal Spoolman REST v1 client (fetch + paging).
 */

export function httpHeaders(jsonBody = false) {
  const h = {
    Accept: "application/json",
    ...(jsonBody ? { "Content-Type": "application/json" } : {}),
  };
  const u = process.env.SPOOLMAN_BASIC_USER;
  const p = process.env.SPOOLMAN_BASIC_PASS;
  if (u != null && p != null) {
    h.Authorization = `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
  }
  return h;
}

export function requireSpoolmanBase() {
  const base = process.env.SPOOLMAN_URL?.replace(/\/$/, "");
  if (!base) {
    console.error("Set SPOOLMAN_URL in .env (e.g. http://192.168.1.10:7912)");
    process.exit(2);
  }
  return base;
}

export async function api(base, method, path, body) {
  const url = `${base.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    method,
    headers: httpHeaders(body != null),
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
  }
  if (!text) return null;
  return JSON.parse(text);
}

export async function fetchPaged(base, resource) {
  const all = [];
  let offset = 0;
  const limit = 200;
  while (true) {
    const chunk = await api(
      base,
      "GET",
      `/api/v1/${resource}?limit=${limit}&offset=${offset}`,
    );
    if (!Array.isArray(chunk) || chunk.length === 0) break;
    all.push(...chunk);
    if (chunk.length < limit) break;
    offset += limit;
  }
  return all;
}

export function filamentVendorId(f) {
  return f.vendor_id ?? f.vendor?.id;
}

export function vendorNameFromFilament(f) {
  return f?.vendor?.name ?? "";
}

export function filamentDedupeKey(vendorId, name, weight) {
  return `${vendorId}|${name}|${weight}`;
}
