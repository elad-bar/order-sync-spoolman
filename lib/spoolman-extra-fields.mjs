/**
 * Spoolman filament "Extra Fields" (Settings → Extra Fields → Filaments).
 *
 * 1) Register field schema (once per Spoolman DB):
 *    GET  /api/v1/field/filament
 *    POST /api/v1/field/filament/{key}
 *    Body: { name, field_type: "integer_range", unit, order, ... }
 *    Key must match ^[a-z0-9_]+$
 *
 * 2) Filament values: post.extra is dict[str, str]; each value must be JSON text.
 *    integer_range decodes to a list of two integers: "[190, 220]"
 *
 * @see https://donkie.github.io/Spoolman/
 * @see Spoolman spoolman/extra_fields.py validate_extra_field_value
 */

import { api } from "./spoolman-client.mjs";

const EM_DASH = "\u2014";

/** Keys used in our inventory export and in Spoolman UI. */
export const FILAMENT_EXTRA_NOZZLE_KEY = "nozzle_temp_range";
export const FILAMENT_EXTRA_BED_KEY = "bed_temp_range";
export const SPOOL_EXTRA_AMAZON_ORDER_KEY = "amazon_order_id";

/** POST /api/v1/field/filament/{key} payloads (key is in the URL only). */
export const FILAMENT_EXTRA_FIELD_DEFINITIONS = [
  {
    key: FILAMENT_EXTRA_NOZZLE_KEY,
    body: {
      name: "Nozzle temperature (min–max °C)",
      order: 0,
      unit: "°C",
      field_type: "integer_range",
    },
  },
  {
    key: FILAMENT_EXTRA_BED_KEY,
    body: {
      name: "Bed temperature (min–max °C)",
      order: 1,
      unit: "°C",
      field_type: "integer_range",
    },
  },
];

/** POST /api/v1/field/spool/{key} payloads (key is in the URL only). */
export const SPOOL_EXTRA_FIELD_DEFINITIONS = [
  {
    key: SPOOL_EXTRA_AMAZON_ORDER_KEY,
    body: {
      name: "Amazon order ID",
      order: 0,
      field_type: "text",
    },
  },
];

/**
 * Normalized Amazon order id for spool extra, or null if missing / placeholder.
 * Incremental spool push requires a non-null value for every exported spool.
 */
export function amazonOrderIdForSpoolExtra(orderIdCell) {
  const s = (orderIdCell ?? "").trim();
  if (!s || s === "-" || s === EM_DASH) return null;
  return s;
}

/**
 * Decode amazon_order_id from API spool.extra (values are JSON strings).
 */
export function parseAmazonOrderIdFromSpoolApi(spool) {
  const raw = spool?.extra?.[SPOOL_EXTRA_AMAZON_ORDER_KEY];
  if (raw == null || raw === "") return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  } catch {
    return null;
  }
}

/** Build Spoolman `extra` entries (JSON strings) from inventory filament entry. */
export function buildFilamentExtraFromEntry(entry) {
  const o = {};
  const emin = entry.settings_extruder_temp_min;
  const emax = entry.settings_extruder_temp_max;
  const bmin = entry.settings_bed_temp_min;
  const bmax = entry.settings_bed_temp_max;
  if (Number.isFinite(emin) && Number.isFinite(emax)) {
    o[FILAMENT_EXTRA_NOZZLE_KEY] = JSON.stringify([emin, emax]);
  }
  if (Number.isFinite(bmin) && Number.isFinite(bmax)) {
    o[FILAMENT_EXTRA_BED_KEY] = JSON.stringify([bmin, bmax]);
  }
  return o;
}

/** Merge temperature ranges onto `post.extra` for POST/PATCH filament. */
export function syncFilamentEntryExtrasToPost(entry) {
  if (!entry?.post) return;
  const delta = buildFilamentExtraFromEntry(entry);
  if (Object.keys(delta).length === 0) return;
  entry.post.extra = { ...(entry.post.extra || {}), ...delta };
}

/**
 * Ensure UI/API knows about our filament extra fields (idempotent).
 */
export async function ensureFilamentExtraFieldDefinitions(base) {
  const existing = await api(base, "GET", "/api/v1/field/filament");
  if (!Array.isArray(existing)) return;
  const keys = new Set(existing.map((f) => f.key));
  for (const { key, body } of FILAMENT_EXTRA_FIELD_DEFINITIONS) {
    if (keys.has(key)) continue;
    await api(base, "POST", `/api/v1/field/filament/${key}`, body);
    console.log(`Registered filament extra field: ${key}`);
  }
}

/** Ensure spool extra field definitions exist (idempotent). */
export async function ensureSpoolExtraFieldDefinitions(base) {
  const existing = await api(base, "GET", "/api/v1/field/spool");
  if (!Array.isArray(existing)) return;
  const keys = new Set(existing.map((f) => f.key));
  for (const { key, body } of SPOOL_EXTRA_FIELD_DEFINITIONS) {
    if (keys.has(key)) continue;
    await api(base, "POST", `/api/v1/field/spool/${key}`, body);
    console.log(`Registered spool extra field: ${key}`);
  }
}

/**
 * Merge new extra keys into existing filament `extra` from API (PATCH replaces
 * whole `extra` if sent; merged map preserves unrelated keys).
 */
export function mergeFilamentExtra(existingExtra, entry) {
  const delta = buildFilamentExtraFromEntry(entry);
  if (Object.keys(delta).length === 0) return null;
  return { ...(existingExtra && typeof existingExtra === "object" ? existingExtra : {}), ...delta };
}
