/**
 * Parse inventory markdown (default: data/filament-inventory.md) and build Spoolman JSON.
 *
 * Each filament entry includes `colors` (hex array, no #) and `color_direction`
 * (null for single-color, or e.g. coaxial / longitudinal for multi). The same
 * data is mirrored onto `post` for the Spoolman API (lib/spoolman-filament-api.mjs).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { inferColorsFromInventoryRow } from "./filament-colors.mjs";
import {
  applyColorsToSpoolmanPost,
  syncFilamentEntryTempsToPost,
} from "./spoolman-filament-api.mjs";
import {
  amazonOrderIdForSpoolExtra,
  SPOOL_EXTRA_AMAZON_ORDER_KEY,
  syncFilamentEntryExtrasToPost,
} from "./spoolman-extra-fields.mjs";
import { parseTempRangeCell } from "./temp-range.mjs";

const EM_DASH = "\u2014";

export function defaultDensity(material) {
  const m = (material || "").toUpperCase().replace(/\s/g, "");
  if (m.includes("TPU")) return 1.2;
  if (m.includes("PETG")) return 1.27;
  if (m.includes("ABS")) return 1.04;
  if (m.includes("ASA")) return 1.07;
  return 1.24;
}

export function parseNetWeightGrams(weightCell) {
  const w = (weightCell || "").trim();
  if (!w) return { grams: null, note: "empty weight" };
  const low = w.toLowerCase();
  if (low.includes("weight not split") || low.includes("not split")) {
    return { grams: 1000, note: "assumed 1000g net (weight not split in source)" };
  }
  let m = w.match(/([\d.]+)\s*kg/i);
  if (m) return { grams: Math.round(parseFloat(m[1]) * 1000), note: "" };
  m = w.match(/([\d.]+)\s*g\b/i);
  if (m) return { grams: Math.round(parseFloat(m[1])), note: "" };
  return { grams: null, note: `unparsed weight: ${JSON.stringify(w)}` };
}

export function parseUnitPriceUsd(priceCell) {
  const s = (priceCell || "").trim().replace(/\s*\*[^*]*\*/g, "");
  const m = s.match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

export function parseQty(cell) {
  const n = parseInt(String(cell || "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function normalizeVendor(name) {
  const n = (name || "").trim();
  if (n === EM_DASH || n === "-" || n === "") return "Unknown";
  return n.length > 64 ? n.slice(0, 64) : n;
}

export function filamentKey(vendorKey, itemName, netG) {
  return `${vendorKey}|${itemName.trim()}|${netG}`;
}

function filamentCommentFromRow(r, weightNote, tempSummary) {
  const parts = [`Product: ${r.product_name}`, `Color: ${r.color}`];
  if (weightNote) parts.push(`Weight note: ${weightNote}`);
  if (tempSummary) parts.push(tempSummary);
  return parts.join(" | ").slice(0, 1900);
}

function spoolCommentFromRow(r) {
  const bits = [];
  if (r.order_id && r.order_id !== EM_DASH) bits.push(`Order: ${r.order_id}`);
  if (r.order_placed) bits.push(`Placed: ${r.order_placed}`);
  if (r.order_status) bits.push(`Status: ${r.order_status}`);
  return bits.join(" | ").slice(0, 1900);
}

export function parseInventoryMarkdown(text) {
  const rows = [];
  let inTable = false;
  let headerSeen = false;
  const expected = [
    "Product name",
    "Manufacturer",
    "Item name",
    "Type",
    "Color",
    "Weight (unit)",
    "Extruder (°C)",
    "Bed (°C)",
    "Unit price (USD)",
    "Qty",
    "Order status",
    "Order ID",
    "Order placed",
  ];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/\s+$/, "");
    if (!trimmed.startsWith("|")) continue;

    const cells = trimmed
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c !== "");
    if (cells.length === 0) continue;

    const c0 = cells[0];
    if (/^:?-+:?$/.test(c0) || c0.startsWith("---")) continue;

    const lower0 = cells[0].toLowerCase();
    const lower1 = cells[1] ? cells[1].toLowerCase() : "";
    if (lower0.includes("product name") && lower1.includes("manufacturer")) {
      inTable = true;
      headerSeen = true;
      if (cells.slice(0, expected.length).join("\0") !== expected.join("\0")) {
        console.warn(
          "Warning: table header differs from expected inventory markdown schema; parsing by position anyway.",
        );
      }
      continue;
    }
    if (!inTable || !headerSeen || cells.length < 13) continue;

    const [
      product_name,
      manufacturer,
      item_name,
      material,
      color,
      weight_unit,
      extruder_c,
      bed_c,
      price_cell,
      qty_cell,
      order_status,
      order_id,
      order_placed,
    ] = cells;

    rows.push({
      product_name,
      manufacturer,
      item_name,
      material,
      color,
      weight_unit,
      extruder_c: extruder_c.trim(),
      bed_c: bed_c.trim(),
      unit_price_usd: parseUnitPriceUsd(price_cell),
      qty: parseQty(qty_cell),
      order_status,
      order_id: order_id.trim(),
      order_placed: order_placed.trim(),
    });
  }
  return rows;
}

export function buildExport(rows) {
  const vendorOrder = [];
  const seenV = new Set();
  const filamentFirst = new Map();
  const spools = [];
  const errors = [];

  for (const r of rows) {
    const { grams, note } = parseNetWeightGrams(r.weight_unit);
    if (grams == null) {
      errors.push(`${r.item_name}: ${note}`);
      continue;
    }

    const vk = normalizeVendor(r.manufacturer);
    if (!seenV.has(vk)) {
      seenV.add(vk);
      vendorOrder.push(vk);
    }

    const fk = filamentKey(vk, r.item_name, grams);
    if (!filamentFirst.has(fk)) {
      filamentFirst.set(fk, { r, wnote: note, grams, vk });
    }

    const sc = spoolCommentFromRow(r);
    for (let i = 0; i < r.qty; i++) {
      const post = { filament_id: null, comment: sc };
      if (r.unit_price_usd != null) post.price = r.unit_price_usd;
      const oidExtra = amazonOrderIdForSpoolExtra(r.order_id);
      if (oidExtra != null) {
        post.extra = {
          [SPOOL_EXTRA_AMAZON_ORDER_KEY]: JSON.stringify(oidExtra),
        };
      }
      spools.push({
        _filament_key: fk,
        _source: {
          product_name: r.product_name,
          item_name: r.item_name,
          order_id: r.order_id,
          order_placed: r.order_placed,
        },
        post,
      });
    }
  }

  const vendorsJson = vendorOrder.map((name) => ({
    _key: name,
    name,
    comment: "",
    empty_spool_weight: 200,
  }));

  const filamentsJson = [...filamentFirst.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([fk, evl]) => {
      const { r, wnote, grams, vk } = evl;
      const exR = parseTempRangeCell(r.extruder_c);
      const bedR = parseTempRangeCell(r.bed_c);
      let tempSummary = "";
      if (exR && bedR) {
        tempSummary = `Nozzle ${exR.min}–${exR.max} °C · Bed ${bedR.min}–${bedR.max} °C (Spoolman: min ${exR.min} / ${bedR.min})`;
      } else if (exR) {
        tempSummary = `Nozzle ${exR.min}–${exR.max} °C`;
      } else if (bedR) {
        tempSummary = `Bed ${bedR.min}–${bedR.max} °C`;
      }
      const fcom = filamentCommentFromRow(r, wnote, tempSummary);
      let mat = r.material || "Unknown";
      if (mat.length > 64) mat = mat.slice(0, 64);
      const nameMax = 64;
      const nameFull = r.item_name.trim();
      let nm = nameFull;
      if (nm.length > nameMax) nm = nm.slice(0, nameMax);
      let comment = fcom.slice(0, 2000);
      if (nameFull.length > nameMax) {
        comment = `Full item name: ${nameFull} | ${fcom}`.slice(0, 2000);
      }
      const { colors, color_direction } = inferColorsFromInventoryRow(r);
      const post = {
        name: nm,
        vendor_id: null,
        material: mat,
        price: r.unit_price_usd ?? 0,
        density: defaultDensity(r.material),
        diameter: 1.75,
        weight: grams,
        spool_weight: 200,
        comment,
      };
      applyColorsToSpoolmanPost(post, colors, color_direction);
      const entry = {
        _key: fk,
        vendor_key: vk,
        colors,
        color_direction,
        settings_extruder_temp_min: exR?.min ?? null,
        settings_extruder_temp_max: exR?.max ?? null,
        settings_bed_temp_min: bedR?.min ?? null,
        settings_bed_temp_max: bedR?.max ?? null,
        post,
      };
      syncFilamentEntryTempsToPost(entry);
      syncFilamentEntryExtrasToPost(entry);
      return entry;
    });

  filamentsJson.sort((a, b) => {
    const v = a.vendor_key.localeCompare(b.vendor_key);
    return v !== 0 ? v : a.post.name.localeCompare(b.post.name);
  });

  return { vendorsJson, filamentsJson, spools, errors };
}

const j = (o) => JSON.stringify(o, null, 2) + "\n";

/** Write vendors.json, filaments.json, spools.json, export_meta.json under `out`. */
export async function writeSpoolmanDataDir(out, markdownPath, rows) {
  if (rows.length === 0) {
    throw new Error(`No table rows parsed from ${markdownPath}`);
  }

  const { vendorsJson, filamentsJson, spools, errors } = buildExport(rows);

  await mkdir(out, { recursive: true });

  await writeFile(join(out, "vendors.json"), j(vendorsJson), "utf8");
  await writeFile(join(out, "filaments.json"), j(filamentsJson), "utf8");
  await writeFile(join(out, "spools.json"), j(spools), "utf8");
  await writeFile(
    join(out, "export_meta.json"),
    j({
      source_markdown: markdownPath,
      vendor_count: vendorsJson.length,
      filament_count: filamentsJson.length,
      spool_count: spools.length,
      skipped_rows: errors,
    }),
    "utf8",
  );

  return { vendorsJson, filamentsJson, spools, errors };
}

export async function migrateFromMarkdown(markdownPath, outDir) {
  const raw = await readFile(markdownPath, "utf8");
  const rows = parseInventoryMarkdown(raw);
  const result = await writeSpoolmanDataDir(outDir, markdownPath, rows);
  return { ...result, markdownPath, outDir };
}
