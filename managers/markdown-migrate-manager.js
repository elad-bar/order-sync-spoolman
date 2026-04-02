/**
 * Markdown → canonical data/inventory.json. All migrate behavior lives on
 * {@link MarkdownMigrateManager}.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getLogger } from "../lib/logger.js";
import { EM_DASH } from "../models/common.js";
import { NAME_TO_HEX } from "../models/migrate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const log = getLogger("migrate");

export class MarkdownMigrateManager {
  constructor(options = {}) {
    this.options = options;
  }

  #parseTempRangeCell(cell) {
    const s = String(cell || "").trim();
    if (!s) return null;
    const parts = s.split(/\s*[–-]\s*/u).map((x) => x.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    const nums = parts
      .map((p) => parseInt(p.replace(/[^\d-]/g, ""), 10))
      .filter((n) => Number.isFinite(n));
    if (nums.length === 0) return null;
    if (nums.length === 1) return { min: nums[0], max: nums[0] };
    return { min: Math.min(...nums), max: Math.max(...nums) };
  }

  #rangeOrNull(r) {
    if (r == null) return null;
    if (!Number.isFinite(r.min) || !Number.isFinite(r.max)) return null;
    return { min: r.min, max: r.max };
  }

  #stripParens(s) {
    return (s || "").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  }

  #splitColorSegments(colorCell) {
    const core = this.#stripParens(colorCell);
    if (!core) return [];
    if (core.includes(" / ")) {
      return core
        .split(" / ")
        .map((t) => t.trim())
        .filter(Boolean);
    }
    if (/\s*\+\s*/.test(core)) {
      return core
        .split(/\s*\+\s*/)
        .map((t) => t.trim())
        .filter(Boolean);
    }
    return [core];
  }

  #phraseToHex(phrase) {
    const p = phrase.toLowerCase().trim();
    if (!p) return null;
    if (p.startsWith("#") && /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(p)) {
      return p.slice(1).toUpperCase();
    }
    const keys = Object.keys(NAME_TO_HEX).sort((a, b) => b.length - a.length);
    const words = p.split(/\s+/).filter(Boolean);
    for (let i = words.length - 1; i >= 0; i--) {
      const tail = words.slice(i).join(" ");
      if (NAME_TO_HEX[tail]) return NAME_TO_HEX[tail];
      if (NAME_TO_HEX[words[i]]) return NAME_TO_HEX[words[i]];
    }
    for (const name of keys) {
      if (p.includes(name)) return NAME_TO_HEX[name];
    }
    return "B0B0B0";
  }

  #inferColorsFromInventoryRow(r) {
    const colorCell = r.color || "";
    const item = (r.item_name || "").toLowerCase();
    const product = (r.product_name || "").toLowerCase();
    const cLow = colorCell.toLowerCase();

    if (
      cLow.includes("rainbow") ||
      cLow.includes("gradient") ||
      product.includes("rainbow") ||
      product.includes("gradient")
    ) {
      return {
        colors: ["FF0000", "FF8800", "FFFF00", "00CC00", "0066FF", "8800FF"],
        color_direction: "longitudinal",
      };
    }

    if (
      item.includes("black / red") ||
      item.includes("black/red") ||
      (cLow.includes("black") &&
        cLow.includes("red") &&
        (cLow.includes("/") || colorCell.includes(" / ")))
    ) {
      return {
        colors: ["000000", "C62828"],
        color_direction: "coaxial",
      };
    }

    const segments = this.#splitColorSegments(colorCell);
    const hexes = [...new Set(segments.map((seg) => this.#phraseToHex(seg)).filter(Boolean))];

    if (hexes.length > 1) {
      return { colors: hexes, color_direction: "coaxial" };
    }
    if (hexes.length === 1) {
      return { colors: hexes, color_direction: null };
    }
    return { colors: ["B0B0B0"], color_direction: null };
  }

  #defaultDensity(material) {
    const m = (material || "").toUpperCase().replace(/\s/g, "");
    if (m.includes("TPU")) return 1.2;
    if (m.includes("PETG")) return 1.27;
    if (m.includes("ABS")) return 1.04;
    if (m.includes("ASA")) return 1.07;
    return 1.24;
  }

  #parseNetWeightGrams(weightCell) {
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

  #parseUnitPriceUsd(priceCell) {
    const s = (priceCell || "").trim().replace(/\s*\*[^*]*\*/g, "");
    const m = s.match(/([\d.]+)/);
    return m ? parseFloat(m[1]) : null;
  }

  #parseQty(cell) {
    const n = parseInt(String(cell || "").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  #normalizeVendorName(name) {
    const raw = (name || "").trim();
    if (raw === EM_DASH || raw === "-" || raw === "") return "Unknown";
    return raw.length > 64 ? raw.slice(0, 64) : raw;
  }

  #vendorKey(name) {
    return this.#normalizeVendorName(name).toLowerCase();
  }

  /** Item name if short; else product title (see INVENTORY-PLAN.md). */
  #canonicalFilamentNameFromRow(r) {
    const item = (r.item_name || "").trim();
    const product = (r.product_name || "").trim();
    if (item.length > 64) return product || item;
    return item || product;
  }

  /** Stable filament id: vendorId|name|weightNetGrams — middle segment must equal `name`. */
  #filamentId(vendorId, name, weightNetGrams) {
    return `${vendorId}|${String(name).trim()}|${weightNetGrams}`;
  }

  /** FIFO reuse of stable ids when re-running migrate (same filament + purchase order). */
  #spoolMergeKey(spool) {
    return `${spool.filamentId}\0${JSON.stringify(spool.purchase)}`;
  }

  /**
   * @param {Array<{ filamentId: string; purchase: object }>} spoolsOut
   * @param {unknown} previousDocument
   */
  #assignStableSpoolIds(spoolsOut, previousDocument) {
    /** @type {Map<string, string[]>} */
    const queues = new Map();
    const prev = previousDocument?.spools;
    if (Array.isArray(prev)) {
      for (const s of prev) {
        if (s == null || typeof s.id !== "string" || s.id.length === 0) continue;
        if (typeof s.filamentId !== "string" || s.purchase == null) continue;
        const key = this.#spoolMergeKey({
          filamentId: s.filamentId,
          purchase: s.purchase,
        });
        if (!queues.has(key)) queues.set(key, []);
        queues.get(key).push(s.id);
      }
    }

    for (const s of spoolsOut) {
      const key = this.#spoolMergeKey(s);
      const q = queues.get(key);
      const reused = q != null && q.length > 0 ? q.shift() : null;
      s.id = reused != null ? reused : randomUUID();
    }
  }

  /**
   * Same order + (orderId, filamentId) → `purchase.itemNumber` 1..Y, `purchase.totalQuantity` Y (§3c line key).
   */
  #assignSpoolCopyMeta(spoolsOut) {
    /** @type {Map<string, number[]>} */
    const groups = new Map();
    for (let i = 0; i < spoolsOut.length; i++) {
      const s = spoolsOut[i];
      const oid = s.purchase?.orderId != null ? String(s.purchase.orderId) : "";
      const k = `${s.filamentId}\0${oid}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    }
    for (const indices of groups.values()) {
      const y = indices.length;
      for (let j = 0; j < indices.length; j++) {
        const s = spoolsOut[indices[j]];
        s.purchase.itemNumber = j + 1;
        s.purchase.totalQuantity = y;
        delete s.copyIndex;
        delete s.copyCount;
        delete s.copyOf;
      }
    }
  }

  #parseInventoryMarkdown(text) {
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
          log.warn(
            "table header differs from expected inventory markdown schema; parsing by position anyway",
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
        unit_price_usd: this.#parseUnitPriceUsd(price_cell),
        qty: this.#parseQty(qty_cell),
        order_status,
        order_id: order_id.trim(),
        order_placed: order_placed.trim(),
      });
    }
    return rows;
  }

  #buildCanonicalInventory(rows, sourceMarkdownPath, previousDocument) {
    const vendorOrder = [];
    const seenV = new Set();
    const vendorDisplayByKey = new Map();
    const filamentFirst = new Map();
    const spoolsOut = [];
    const errors = [];

    for (const r of rows) {
      const { grams, note } = this.#parseNetWeightGrams(r.weight_unit);
      if (grams == null) {
        errors.push(`${r.item_name}: ${note}`);
        continue;
      }

      const vk = this.#vendorKey(r.manufacturer);
      if (!vendorDisplayByKey.has(vk)) {
        vendorDisplayByKey.set(vk, this.#normalizeVendorName(r.manufacturer));
      }
      if (!seenV.has(vk)) {
        seenV.add(vk);
        vendorOrder.push(vk);
      }

      const displayName = this.#canonicalFilamentNameFromRow(r);
      const fid = this.#filamentId(vk, displayName, grams);
      if (!filamentFirst.has(fid)) {
        filamentFirst.set(fid, { r, grams, vk, displayName });
      }

      const unit = r.unit_price_usd ?? 0;
      for (let i = 0; i < r.qty; i++) {
        spoolsOut.push({
          filamentId: fid,
          purchase: {
            orderId: r.order_id,
            placedDate: r.order_placed,
            status: r.order_status ?? "",
            unitPriceUsd: unit,
          },
        });
      }
    }

    this.#assignStableSpoolIds(spoolsOut, previousDocument);
    this.#assignSpoolCopyMeta(spoolsOut);

    const vendors = vendorOrder.map((vk) => ({
      id: vk,
      name: vendorDisplayByKey.get(vk),
      emptySpoolWeightGrams: 200,
    }));

    const filaments = [...filamentFirst.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([idKey, evl]) => {
        const { r, grams, vk, displayName } = evl;
        const exR = this.#parseTempRangeCell(r.extruder_c);
        const bedR = this.#parseTempRangeCell(r.bed_c);
        let mat = r.material || "Unknown";
        if (mat.length > 64) mat = mat.slice(0, 64);
        const { colors, color_direction } = this.#inferColorsFromInventoryRow(r);

        return {
          id: idKey,
          vendorId: vk,
          name: displayName,
          productTitle: (r.product_name || "").trim(),
          material: mat,
          density: this.#defaultDensity(r.material),
          diameterMm: 1.75,
          weightNetGrams: grams,
          spoolWeightGrams: 200,
          colors: {
            description: (r.color || "").trim(),
            hexes: colors,
            direction: color_direction,
          },
          settings: {
            extruderTempC: this.#rangeOrNull(exR),
            bedTempC: this.#rangeOrNull(bedR),
          },
        };
      });

    return {
      document: {
        generatedAt: new Date().toISOString(),
        source: { kind: "markdown", path: sourceMarkdownPath.replace(/\\/g, "/") },
        migrateNotes: {
          skippedRows: errors,
          vendorCount: vendors.length,
          filamentCount: filaments.length,
          spoolCount: spoolsOut.length,
        },
        vendors,
        filaments,
        spools: spoolsOut,
      },
      errors,
    };
  }

  async run() {
    const markdown = join(__dirname, "..", "data", "amazon-filament-inventory.md");
    const out = join(__dirname, "..", "data", "inventory.json");
    const raw = await readFile(markdown, "utf8");
    const rows = this.#parseInventoryMarkdown(raw);
    if (rows.length === 0) {
      throw new Error(`No table rows parsed from ${markdown}`);
    }

    let previousDocument = null;
    try {
      previousDocument = JSON.parse(await readFile(out, "utf8"));
    } catch {
      previousDocument = null;
    }

    const { document } = this.#buildCanonicalInventory(rows, markdown, previousDocument);

    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(document, null, 2) + "\n", "utf8");

    log.info(
      `wrote ${out}: ${document.vendors.length} vendors, ${document.filaments.length} filaments, ${document.spools.length} spools`,
    );
    if (document.migrateNotes.skippedRows.length > 0) {
      log.warn(
        `skipped ${document.migrateNotes.skippedRows.length} row(s); see migrateNotes.skippedRows in ${out}`,
      );
    }

    return { document, markdownPath: markdown, outPath: out };
  }
}
