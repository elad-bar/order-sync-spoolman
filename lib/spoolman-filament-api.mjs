/**
 * Filament color fields per Spoolman REST API (see Add / Update Filament):
 * https://donkie.github.io/Spoolman/
 *
 * Inventory JSON uses `colors` (hex strings, no #) + `color_direction` (null | string).
 * This module maps that onto `post` for API requests.
 */

export const FILAMENT_COLOR_API_FIELDS = [
  "color_hex",
  "multi_color_hexes",
  "multi_color_direction",
];

/** Normalize hex token (strip #, uppercase). */
function normHex(h) {
  const s = String(h || "").trim().replace(/^#/, "");
  return s ? s.toUpperCase() : "";
}

/**
 * Apply `colors` + `color_direction` to a Spoolman filament `post` payload.
 * Single color → color_hex only; multi → multi_color_hexes + multi_color_direction;
 * clears the opposite mode with null so PATCH can replace prior server state.
 */
export function applyColorsToSpoolmanPost(post, colors, color_direction) {
  const norm = (Array.isArray(colors) ? colors : [])
    .map(normHex)
    .filter(Boolean);
  delete post.color_hex;
  delete post.multi_color_hexes;
  delete post.multi_color_direction;

  if (norm.length === 0) return;

  if (norm.length === 1) {
    post.color_hex = norm[0];
    post.multi_color_hexes = null;
    post.multi_color_direction = null;
    return;
  }

  post.color_hex = null;
  post.multi_color_hexes = norm.join(",");
  post.multi_color_direction = color_direction || "coaxial";
}

/** If entry has `colors`, refresh `post` color fields before push. */
export function syncFilamentEntryColorsToPost(entry) {
  if (!entry?.post) return;
  if (Array.isArray(entry.colors) && entry.colors.length > 0) {
    applyColorsToSpoolmanPost(entry.post, entry.colors, entry.color_direction ?? null);
  }
}

/** Spoolman accepts single ints; we store min/max separately in filaments.json. */
export const FILAMENT_TEMP_API_FIELDS = [
  "settings_extruder_temp",
  "settings_bed_temp",
];

/**
 * Copy minimum temperatures from entry onto `post` for API create/PATCH.
 * Expects `settings_*_temp_min` from inventory export (see lib/temp-range.mjs).
 */
export function syncFilamentEntryTempsToPost(entry) {
  if (!entry?.post) return;
  const e = entry.settings_extruder_temp_min;
  const b = entry.settings_bed_temp_min;
  if (Number.isFinite(e)) entry.post.settings_extruder_temp = e;
  if (Number.isFinite(b)) entry.post.settings_bed_temp = b;
}

/** Subset of `post` suitable for PATCH when syncing colors to Spoolman. */
export function colorFieldsForPatch(post) {
  const o = {};
  for (const k of FILAMENT_COLOR_API_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(post, k)) o[k] = post[k];
  }
  return o;
}

export function tempFieldsForPatch(post) {
  const o = {};
  for (const k of FILAMENT_TEMP_API_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(post, k)) o[k] = post[k];
  }
  return o;
}
