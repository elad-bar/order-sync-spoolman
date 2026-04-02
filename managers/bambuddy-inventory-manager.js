/**
 * Pushes `data/inventory.json` to a Bambuddy instance (`BAMBUDDY_URL` origin + `/api/v1/...`).
 *
 * Covers filament catalog, inventory core-weight + color catalogs, and per-spool inventory rows. Spool identity in
 * `note` is built with the line-key helpers below (same file).
 *
 * Live API shapes: your server’s `/docs` and `/openapi.json`.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BaseInventoryManager } from "./base-inventory-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVENTORY_JSON_PATH = join(__dirname, "..", "data", "inventory.json");

// --- Bambuddy API note / line-key / color formatting (constraints per `schemas/spool.py`) ---

const BAMBUDDY_NOTE_MAX = 500;

/** Short hash prefix when full §3c line key exceeds note budget (§3c). */
const LINE_KEY_HASH_PREFIX = "invkey:";

/**
 * Exact §3c line key (before note-length fallback).
 * @param {string | null | undefined} orderId
 * @param {string | null | undefined} filamentId
 * @param {number} x
 * @param {number} y
 */
function buildSpoolLineKey(orderId, filamentId, x, y) {
  return `${String(orderId ?? "").trim()} - ${String(filamentId ?? "").trim()} (${Number(x)} of ${Number(y)})`;
}

/**
 * Line-identity string for spool `note` (full §3c key or `invkey:` hash when over limit).
 */
function spoolLineKeyForNote(orderId, filamentId, x, y) {
  const full = buildSpoolLineKey(orderId, filamentId, x, y);
  /** Room under {@link BAMBUDDY_NOTE_MAX} (no `[inv:uuid]` suffix on new rows). */
  const reserve = 0;
  const maxKey = BAMBUDDY_NOTE_MAX - reserve;
  if (full.length <= maxKey) return full;
  const h = createHash("sha256").update(full).digest("hex").slice(0, 20);
  return `${LINE_KEY_HASH_PREFIX}${h}`;
}

/**
 * Identity token for server row: strip trailing `[inv:uuid]`; used for === compare to local
 * {@link spoolLineKeyForNote} (or null if empty).
 * @param {string | null | undefined} note
 */
function parseSpoolNoteIdentityToken(note) {
  const noInv = String(note ?? "")
    .replace(/\s*\[inv:[0-9a-f-]{36}\]\s*$/i, "")
    .trim();
  return noInv || null;
}

/** @param {string} s */
function truncateBambuddyNote(s) {
  const t = String(s ?? "").trim();
  if (t.length <= BAMBUDDY_NOTE_MAX) return t;
  return t.slice(0, BAMBUDDY_NOTE_MAX);
}

const INV_TAG =
  /\[inv:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i;
const CANONICAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** @param {string | null | undefined} note */
function parseInventorySpoolIdFromNote(note) {
  const m = String(note ?? "").match(INV_TAG);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Parsed spool note for Phase 4 matching (§3c + legacy §11).
 * @param {string | null | undefined} note
 */
function parseSpoolLineKeyFromNote(note) {
  return {
    identityToken: parseSpoolNoteIdentityToken(note),
    legacyInv: parseInventorySpoolIdFromNote(note),
  };
}

/**
 * Append stable inventory spool id so Bambuddy rows can be matched without a local map file.
 * Tag is always `[inv:<uuid>]` at the end; human text is truncated to fit `BAMBUDDY_NOTE_MAX`.
 * @param {string | null | undefined} noteBase
 * @param {string} canonicalUuid
 */
function appendInventorySpoolIdToNote(noteBase, canonicalUuid) {
  const uuid = String(canonicalUuid || "").trim().toLowerCase();
  if (!CANONICAL_UUID_RE.test(uuid)) {
    return noteBase ? truncateBambuddyNote(String(noteBase)) : null;
  }
  const tag = ` [inv:${uuid}]`;
  let base = String(noteBase ?? "").trim();
  base = base.replace(/\s*\[inv:[0-9a-f-]{36}\]\s*$/i, "").trim();
  const maxBase = BAMBUDDY_NOTE_MAX - tag.length;
  if (maxBase < 1) {
    return tag.trim().slice(0, BAMBUDDY_NOTE_MAX);
  }
  if (base.length > maxBase) base = base.slice(0, maxBase);
  return base + tag;
}

/**
 * Bambuddy `rgba` pattern: 8 hex chars RRGGBBAA. Inventory uses 6-char RGB.
 * @param {string | undefined | null} hex6
 * @returns {string | null}
 */
function rgba6ToRgba8(hex6) {
  if (hex6 == null || hex6 === "") return null;
  const h = String(hex6).replace(/^#/, "").trim().toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(h)) return null;
  return `${h}FF`;
}

/**
 * Bambuddy filament-catalog `color_hex`: `^#[0-9A-Fa-f]{6}$`
 * @param {string | undefined | null} hex6
 * @returns {string | null}
 */
function hex6ToFilamentColorHex(hex6) {
  if (hex6 == null || hex6 === "") return null;
  const h = String(hex6).replace(/^#/, "").trim();
  if (!/^[0-9A-Fa-f]{6}$/.test(h)) return null;
  return `#${h.toUpperCase()}`;
}

/** Bambuddy `SpoolBulkCreate.quantity` max (`schemas/spool.py`). */
const BAMBUDDY_SPOOL_BULK_MAX = 100;

export class BambuddyInventoryManager extends BaseInventoryManager {
  constructor(options = {}) {
    super({ ...options, inventorySystem: "bambuddy" });
  }

  /**
   * Minimal JSON shapes so dry-run push does not throw (bulk POST returns array length `quantity`).
   * @param {string} method
   * @param {string} path
   * @param {unknown} body
   */
  dryRunStubResponse(method, path, body) {
    if (method === "POST" && path.includes("/inventory/spools/bulk")) {
      const o = /** @type {{ quantity?: number }} */ (body);
      const n = Math.max(1, Math.min(BAMBUDDY_SPOOL_BULK_MAX, Number(o?.quantity) || 1));
      const rows = [];
      for (let i = 0; i < n; i++) rows.push({ id: this.allocateDryRunId() });
      return rows;
    }
    if (method === "POST") {
      return { id: this.allocateDryRunId() };
    }
    return null;
  }

  #getApiKey() {
    const k = this.options.apiKey;
    const key = typeof k === "string" ? k.trim() : "";
    if (!key) {
      this._log.error("Bambuddy API key missing: set BAMBUDDY_API_KEY.");
      process.exit(2);
    }
    return key;
  }

  /** @param {boolean} [jsonBody] */
  httpHeaders(jsonBody = false) {
    return {
      Accept: "application/json",
      "X-API-Key": this.#getApiKey(),
      ...(jsonBody ? { "Content-Type": "application/json" } : {}),
    };
  }

  #normMatchStr(s) {
    return String(s ?? "")
      .trim()
      .toLowerCase();
  }

  /**
   * Map normalized (lowercase) brand/manufacturer → exact string already on Bambuddy
   * (from filament-catalog `brand` and inventory-colors `manufacturer`), so we never POST a second spelling.
   * @param {{ filamentCatalog?: object[]; colors?: object[] }} snap
   * @returns {Map<string, string>}
   */
  #brandManufacturerCanonFromSnap(snap) {
    /** @type {Map<string, string>} */
    const m = new Map();
    const put = (raw) => {
      const t = String(raw ?? "").trim();
      if (!t) return;
      const k = this.#normMatchStr(t);
      if (!m.has(k)) m.set(k, t);
    };
    for (const row of snap.filamentCatalog || []) {
      put(row.brand);
    }
    for (const row of snap.colors || []) {
      put(row.manufacturer);
    }
    return m;
  }

  /**
   * @param {Map<string, string>} canon
   * @param {string | null | undefined} localName
   */
  #canonVendorName(canon, localName) {
    const t = String(localName ?? "").trim();
    if (!t) return t;
    const k = this.#normMatchStr(t);
    const c = canon.get(k);
    return c != null ? c : t;
  }

  /** @param {object} inv */
  #vendorById(inv) {
    return new Map(inv.vendors.map((v) => [v.id, v]));
  }

  async #fetchServerSnapshot() {
    this._log.info("block: server snapshot — GET filament-catalog, inventory catalog, colors, spools");
    const [filamentCatalog, inventoryCatalog, colors, spools] = await Promise.all([
      this.api("GET", "/api/v1/filament-catalog/", undefined),
      this.api("GET", "/api/v1/inventory/catalog", undefined),
      this.api("GET", "/api/v1/inventory/colors", undefined),
      this.api("GET", "/api/v1/inventory/spools", undefined),
    ]);
    if (!Array.isArray(filamentCatalog)) {
      throw new Error("Bambuddy GET /filament-catalog/ did not return an array.");
    }
    if (!Array.isArray(inventoryCatalog)) {
      throw new Error("Bambuddy GET /inventory/catalog did not return an array.");
    }
    if (!Array.isArray(colors)) {
      throw new Error("Bambuddy GET /inventory/colors did not return an array.");
    }
    if (!Array.isArray(spools)) {
      throw new Error("Bambuddy GET /inventory/spools did not return an array.");
    }
    this._log.debug(
      `snapshot: filament-catalog=${filamentCatalog.length} catalog=${inventoryCatalog.length} colors=${colors.length} spools=${spools.length}`,
    );
    return { filamentCatalog, inventoryCatalog, colors, spools };
  }

  /**
   * @param {Record<string, unknown>} f
   * @param {Map<string, string>} canon
   */
  #filamentCatalogBody(f, vendor, minUnitPriceUsd, canon) {
    const grams = f.weightNetGrams;
    const ex = f.settings?.extruderTempC;
    const bed = f.settings?.bedTempC;
    let name = String(f.name || "").trim();
    if (name.length > 100) name = name.slice(0, 100);
    let type = String(f.material || "Unknown").trim();
    if (type.length > 50) type = type.slice(0, 50);
    const brandRaw = String(vendor.name || "").trim() || null;
    const brand =
      brandRaw == null ? null : this.#canonVendorName(canon, brandRaw);
    let color = (f.colors?.description ?? "").trim();
    if (color.length > 100) color = color.slice(0, 100);
    const color_hex = hex6ToFilamentColorHex(f.colors?.hexes?.[0]);
    let cost_per_kg = 25;
    if (
      typeof minUnitPriceUsd === "number" &&
      Number.isFinite(minUnitPriceUsd) &&
      minUnitPriceUsd > 0 &&
      Number.isFinite(grams) &&
      grams > 0
    ) {
      cost_per_kg = (minUnitPriceUsd / grams) * 1000;
    }
    return {
      name,
      type,
      brand,
      color: color || null,
      color_hex: color_hex,
      cost_per_kg,
      spool_weight_g: Number(grams) || 1000,
      currency: "USD",
      density: Number.isFinite(f.density) ? f.density : null,
      print_temp_min: Number.isFinite(ex?.min) ? ex.min : null,
      print_temp_max: Number.isFinite(ex?.max) ? ex.max : null,
      bed_temp_min: Number.isFinite(bed?.min) ? bed.min : null,
      bed_temp_max: Number.isFinite(bed?.max) ? bed.max : null,
    };
  }

  /** @param {Record<string, unknown>} row */
  #filamentCatalogMatches(row, body) {
    return (
      this.#normMatchStr(row.name) === this.#normMatchStr(body.name) &&
      this.#normMatchStr(row.type) === this.#normMatchStr(body.type) &&
      this.#normMatchStr(row.brand) === this.#normMatchStr(body.brand)
    );
  }

  /**
   * @param {object} inv
   * @param {{ filamentCatalog: object[]; colors: object[] }} snap
   */
  async #syncFilamentCatalog(inv, snap) {
    this._log.info(
      `block: filament-catalog — reconcile (${inv.filaments.length} local filament type(s))`,
    );
    const list = snap.filamentCatalog;
    this._log.debug(
      `filament-catalog: server has ${list.length} row(s); checking ${inv.filaments.length} filament(s).`,
    );

    const minPriceByFid = new Map();
    for (const s of inv.spools) {
      const p = s.purchase?.unitPriceUsd;
      const fid = s.filamentId;
      if (typeof p !== "number" || !Number.isFinite(p) || p <= 0) continue;
      const prev = minPriceByFid.get(fid);
      if (prev == null || p < prev) minPriceByFid.set(fid, p);
    }

    const vendorById = this.#vendorById(inv);
    const rows = [...list];
    const total = inv.filaments.length;
    const canon = this.#brandManufacturerCanonFromSnap(snap);

    let skipped = 0;
    let posted = 0;
    for (let idx = 0; idx < inv.filaments.length; idx++) {
      const f = inv.filaments[idx];
      const v = vendorById.get(f.vendorId);
      if (v == null) throw new Error(`Unknown vendorId on filament ${f.id}`);
      const body = this.#filamentCatalogBody(f, v, minPriceByFid.get(f.id), canon);
      if (rows.some((row) => this.#filamentCatalogMatches(row, body))) {
        skipped++;
        this._log.debug(
          `filament-catalog ${idx + 1}/${total}: match existing, skip (${body.name})`,
        );
        continue;
      }
      this._log.debug(
        `filament-catalog create ${posted + 1}: POST ${body.name} (brand=${body.brand})`,
      );
      const created = await this.api("POST", "/api/v1/filament-catalog/", body);
      if (created?.id != null) {
        rows.push(created);
        snap.filamentCatalog.push(created);
        posted++;
        const bc = created.brand != null ? String(created.brand).trim() : "";
        if (bc) {
          canon.set(this.#normMatchStr(bc), bc);
        }
        this._log.debug(`filament-catalog: created id=${created.id}`);
      }
    }

    this._log.info(
      `block: filament-catalog — done (${skipped} already on server, ${posted} created)`,
    );
  }

  #coreWeightForFilament(f, vendor) {
    return f.spoolWeightGrams ?? vendor.emptySpoolWeightGrams ?? 200;
  }

  #spoolCatalogEntryName(vendorName, weight) {
    let name = `${String(vendorName).trim()} empty spool ${weight}g`;
    if (name.length > 120) name = name.slice(0, 120);
    return name;
  }

  /**
   * @param {{ inventoryCatalog: object[]; filamentCatalog: object[]; colors: object[] }} snap
   * @returns {Promise<Map<string, number>>} key vendorId\0weight → catalog id
   */
  async #syncSpoolCatalog(inv, snap) {
    this._log.info("block: core-weight catalog — reconcile vendor/spool weight pairs");
    const list = snap.inventoryCatalog;
    this._log.debug(
      `inventory catalog (core weight): server has ${list.length} row(s).`,
    );

    const vendorById = this.#vendorById(inv);
    const byKey = new Map();
    const rows = [...list];
    const seenPair = new Set();
    let step = 0;
    const pairTotal = inv.filaments.filter((f) => {
      const v = vendorById.get(f.vendorId);
      if (v == null) return false;
      const w = this.#coreWeightForFilament(f, v);
      const k = `${f.vendorId}\0${w}`;
      if (seenPair.has(k)) return false;
      seenPair.add(k);
      return true;
    }).length;
    seenPair.clear();

    /** @type {{ name: string, weight: number, dedupe: string }[]} */
    const toCreate = [];

    const canon = this.#brandManufacturerCanonFromSnap(snap);

    for (const f of inv.filaments) {
      const v = vendorById.get(f.vendorId);
      if (v == null) continue;
      const weight = this.#coreWeightForFilament(f, v);
      const dedupe = `${f.vendorId}\0${weight}`;
      if (seenPair.has(dedupe)) continue;
      seenPair.add(dedupe);
      step++;

      const displayVendor = this.#canonVendorName(canon, v.name ?? "");
      const name = this.#spoolCatalogEntryName(displayVendor, weight);
      const found = rows.find((row) => row.name === name && row.weight === weight);
      if (found != null) {
        byKey.set(dedupe, found.id);
        this._log.debug(
          `core-weight catalog ${step}/${pairTotal}: match id=${found.id} (${name})`,
        );
        continue;
      }

      toCreate.push({ name, weight, dedupe });
    }

    let posted = 0;
    const matched = pairTotal - toCreate.length;
    for (let j = 0; j < toCreate.length; j++) {
      const { name, weight, dedupe } = toCreate[j];
      this._log.debug(
        `core-weight catalog create ${j + 1}/${toCreate.length}: POST ${name}`,
      );
      const created = await this.api("POST", "/api/v1/inventory/catalog", {
        name,
        weight,
      });
      if (created?.id != null) {
        byKey.set(dedupe, created.id);
        rows.push(created);
        snap.inventoryCatalog.push(created);
        posted++;
        this._log.debug(`core-weight catalog: created id=${created.id}`);
      }
    }

    this._log.info(
      `block: core-weight catalog — done (${matched} already on server, ${posted} created)`,
    );
    return byKey;
  }

  /**
   * @param {string} manufacturer
   * @param {string} hexNorm #RRGGBB
   * @param {string} color_name
   */
  #colorCatalogMatches(row, manufacturer, hexNorm, color_name) {
    const rh = String(row.hex_color || "").trim();
    const h =
      rh.startsWith("#") ? `#${rh.slice(1).toUpperCase()}` : `#${rh.toUpperCase()}`;
    return (
      this.#normMatchStr(row.manufacturer) === this.#normMatchStr(manufacturer) &&
      h === hexNorm &&
      this.#normMatchStr(row.color_name) === this.#normMatchStr(color_name)
    );
  }

  /** @param {object} inv @param {{ colors: object[]; filamentCatalog: object[] }} snap */
  async #syncColorCatalog(inv, snap) {
    let colorTotal = 0;
    for (const f of inv.filaments) {
      const hexes = Array.isArray(f.colors?.hexes) ? f.colors.hexes : [];
      for (const h of hexes) {
        if (hex6ToFilamentColorHex(h) != null) colorTotal++;
      }
    }
    this._log.info(
      `block: color catalog — reconcile (${colorTotal} local color hex slot(s))`,
    );

    const list = snap.colors;
    const canon = this.#brandManufacturerCanonFromSnap(snap);

    const vendorById = this.#vendorById(inv);
    const rows = [...list];

    this._log.debug(
      `inventory colors: server has ${list.length} row(s); ${colorTotal} local color hex slot(s) to reconcile.`,
    );

    let idx = 0;
    let skippedColors = 0;
    let postedColors = 0;

    for (const f of inv.filaments) {
      const v = vendorById.get(f.vendorId);
      if (v == null) continue;
      const hexes = Array.isArray(f.colors?.hexes) ? f.colors.hexes : [];
      const desc = String(f.colors?.description || "").trim() || "Unknown";
      let mat = String(f.material || "").trim();
      if (mat.length > 64) mat = mat.slice(0, 64);

      for (let i = 0; i < hexes.length; i++) {
        const hexNorm = hex6ToFilamentColorHex(hexes[i]);
        if (hexNorm == null) continue;

        idx++;
        let color_name = desc;
        if (hexes.length > 1) {
          color_name = `${desc} ${hexNorm}`;
        }
        if (color_name.length > 100) color_name = color_name.slice(0, 100);

        const manufacturer = this.#canonVendorName(canon, v.name ?? "");

        if (
          rows.some((row) =>
            this.#colorCatalogMatches(row, manufacturer, hexNorm, color_name),
          )
        ) {
          skippedColors++;
          this._log.debug(
            `inventory colors ${idx}/${colorTotal}: match, skip ${manufacturer} / ${color_name}`,
          );
          continue;
        }

        this._log.debug(
          `inventory colors create: POST ${manufacturer} / ${color_name} ${hexNorm}`,
        );
        const created = await this.api("POST", "/api/v1/inventory/colors", {
          manufacturer,
          color_name,
          hex_color: hexNorm,
          material: mat || null,
        });
        if (created?.id != null) {
          rows.push(created);
          snap.colors.push(created);
          postedColors++;
          const mc =
            created.manufacturer != null
              ? String(created.manufacturer).trim()
              : "";
          if (mc) {
            canon.set(this.#normMatchStr(mc), mc);
          }
          this._log.debug(`inventory colors: created id=${created.id}`);
        }
      }
    }

    this._log.info(
      `block: color catalog — done (${skippedColors} already on server, ${postedColors} created)`,
    );
  }

  /** @param {Record<string, unknown>} f */
  #subtypeHint(f) {
    const n = `${f.productTitle || ""} ${f.name || ""}`.toLowerCase();
    if (n.includes("silk")) return "Silk";
    if (n.includes("matte")) return "Matte";
    if (n.includes("transparent")) return "Transparent";
    if (n.includes("high speed") || n.includes("hs ") || n.includes(" hf")) return "HF";
    return null;
  }

  /**
   * Pack index for §3c line key: `purchase.itemNumber` / `purchase.totalQuantity`, or legacy `copyIndex` / `copyCount`.
   * @param {object} spoolLine
   * @returns {{ x: number, y: number }}
   */
  #spoolLineXY(spoolLine) {
    const p = spoolLine.purchase;
    if (
      p &&
      typeof p.itemNumber === "number" &&
      p.itemNumber >= 1 &&
      typeof p.totalQuantity === "number" &&
      p.totalQuantity >= 1
    ) {
      return { x: p.itemNumber, y: p.totalQuantity };
    }
    const x =
      typeof spoolLine.copyIndex === "number" && spoolLine.copyIndex >= 1
        ? spoolLine.copyIndex
        : 1;
    const y =
      typeof spoolLine.copyCount === "number" && spoolLine.copyCount >= 1
        ? spoolLine.copyCount
        : 1;
    return { x, y };
  }

  /**
   * @param {object} vendor
   * @param {object} filament
   * @param {object} spoolLine
   * @param {number | null} coreWeightCatalogId
   * @param {Map<string, string>} canon
   */
  #buildCreateBody(vendor, filament, spoolLine, coreWeightCatalogId, canon) {
    const ex = filament.settings?.extruderTempC;
    const grams = filament.weightNetGrams;
    const price = spoolLine.purchase?.unitPriceUsd;
    let cost_per_kg = null;
    if (
      typeof price === "number" &&
      Number.isFinite(price) &&
      price > 0 &&
      Number.isFinite(grams) &&
      grams > 0
    ) {
      cost_per_kg = (price / grams) * 1000;
    }

    const hex0 = filament.colors?.hexes?.[0];
    const rgba = rgba6ToRgba8(hex0);

    const { x, y } = this.#spoolLineXY(spoolLine);
    const lineToken = spoolLineKeyForNote(
      spoolLine.purchase?.orderId,
      spoolLine.filamentId,
      x,
      y,
    );
    const note = truncateBambuddyNote(lineToken);

    let material = String(filament.material || "Unknown").trim();
    if (material.length > 50) material = material.slice(0, 50);

    let color_name = filament.colors?.description?.trim() || null;
    if (color_name != null && color_name.length > 100) {
      color_name = color_name.slice(0, 100);
    }

    let brand = vendor.name?.trim() || null;
    if (brand != null) {
      brand = this.#canonVendorName(canon, brand);
      if (brand.length > 100) brand = brand.slice(0, 100);
    }

    const subtypeRaw = this.#subtypeHint(filament);
    let subtype = subtypeRaw;
    if (subtype != null && subtype.length > 50) subtype = subtype.slice(0, 50);

    const core_weight =
      filament.spoolWeightGrams ?? vendor.emptySpoolWeightGrams ?? 200;

    return {
      material,
      subtype,
      color_name,
      rgba,
      brand,
      label_weight: grams,
      core_weight,
      core_weight_catalog_id: coreWeightCatalogId,
      weight_used: 0,
      slicer_filament: null,
      slicer_filament_name: null,
      nozzle_temp_min: Number.isFinite(ex?.min) ? ex.min : null,
      nozzle_temp_max: Number.isFinite(ex?.max) ? ex.max : null,
      note,
      tag_uid: null,
      tray_uuid: null,
      data_origin: null,
      tag_type: null,
      cost_per_kg,
      weight_locked: false,
    };
  }

  /** PATCH body: omit weight_used. */
  #buildPatchBody(full) {
    const {
      material,
      subtype,
      color_name,
      rgba,
      brand,
      label_weight,
      core_weight,
      core_weight_catalog_id,
      slicer_filament,
      slicer_filament_name,
      nozzle_temp_min,
      nozzle_temp_max,
      note,
      tag_uid,
      tray_uuid,
      data_origin,
      tag_type,
      cost_per_kg,
    } = full;
    return {
      material,
      subtype,
      color_name,
      rgba,
      brand,
      label_weight,
      core_weight,
      core_weight_catalog_id,
      slicer_filament,
      slicer_filament_name,
      nozzle_temp_min,
      nozzle_temp_max,
      note,
      tag_uid,
      tray_uuid,
      data_origin,
      tag_type,
      cost_per_kg,
    };
  }

  #numEq(a, b) {
    if (a == null && b == null) return true;
    if (typeof a !== "number" || typeof b !== "number") return a === b;
    return Math.abs(a - b) < 1e-6;
  }

  /** @param {Record<string, unknown>} server */
  #needsPatch(server, patchBody) {
    const keys = [
      "material",
      "subtype",
      "color_name",
      "rgba",
      "brand",
      "label_weight",
      "core_weight",
      "core_weight_catalog_id",
      "nozzle_temp_min",
      "nozzle_temp_max",
      "note",
      "cost_per_kg",
    ];
    for (const k of keys) {
      const a = server[k];
      const b = patchBody[k];
      if (k === "cost_per_kg") {
        if (!this.#numEq(
          typeof a === "number" ? a : null,
          typeof b === "number" ? b : null,
        )) {
          return true;
        }
        continue;
      }
      if (k === "core_weight_catalog_id") {
        const na = a == null ? null : Number(a);
        const nb = b == null ? null : Number(b);
        if (na !== nb) return true;
        continue;
      }
      if (a !== b) return true;
    }
    return false;
  }

  /**
   * Stable JSON key for grouping identical spool create bodies (POST …/spools/bulk).
   * @param {object} body
   */
  #stableSpoolCreateKey(body) {
    const o = /** @type {Record<string, unknown>} */ (body);
    const keys = Object.keys(o).sort();
    const norm = {};
    for (const k of keys) {
      const v = o[k];
      if (v === undefined) continue;
      norm[k] = v;
    }
    return JSON.stringify(norm);
  }

  /**
   * Ensure `purchase.itemNumber` / `purchase.totalQuantity` for §3c keys; strip legacy `copyIndex` / `copyCount` / `copyOf`.
   */
  #ensureSpoolCopyMeta(spools) {
    const hasValidLine = (s) => {
      const p = s.purchase;
      return (
        p &&
        typeof p.itemNumber === "number" &&
        p.itemNumber >= 1 &&
        typeof p.totalQuantity === "number" &&
        p.totalQuantity >= 1
      );
    };
    const needsAssign = spools.some((s) => !hasValidLine(s));
    if (needsAssign) {
      /** @type {Map<string, number[]>} */
      const groups = new Map();
      for (let i = 0; i < spools.length; i++) {
        const s = spools[i];
        const oid = s.purchase?.orderId != null ? String(s.purchase.orderId) : "";
        const k = `${s.filamentId}\0${oid}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(i);
      }
      for (const indices of groups.values()) {
        const y = indices.length;
        for (let j = 0; j < indices.length; j++) {
          const s = spools[indices[j]];
          if (!s.purchase || typeof s.purchase !== "object") s.purchase = {};
          s.purchase.itemNumber = j + 1;
          s.purchase.totalQuantity = y;
        }
      }
    }
    for (const s of spools) {
      if (hasValidLine(s)) {
        delete s.copyIndex;
        delete s.copyCount;
        delete s.copyOf;
      }
    }
  }

  /** @param {string | null | undefined} tok */
  #looksLikeManagedLineToken(tok) {
    const t = String(tok ?? "").trim();
    if (!t) return false;
    if (t.startsWith(LINE_KEY_HASH_PREFIX)) return true;
    return /\(\d+\s+of\s+\d+\)\s*$/.test(t);
  }

  async #importFromInventory(inventoryPath) {
    const inv = JSON.parse(await readFile(inventoryPath, "utf8"));
    const vendors = inv.vendors;
    const filaments = inv.filaments;
    const spools = inv.spools;
    if (!Array.isArray(vendors) || !Array.isArray(filaments) || !Array.isArray(spools)) {
      throw new Error("inventory.json must contain vendors, filaments, spools arrays.");
    }

    const filamentById = new Map(filaments.map((f) => [f.id, f]));
    const vendorById = this.#vendorById(inv);
    this.#ensureSpoolCopyMeta(spools);

    this._log.info(
      `block: push — ${spools.length} spool line(s), ${filaments.length} filament(s); ${inventoryPath}`,
    );
    this._log.debug(
      "rate limits: honoring X-RateLimit-* and retrying HTTP 429 where needed.",
    );

    const snap = await this.#fetchServerSnapshot();
    await this.#syncFilamentCatalog(inv, snap);
    const spoolCatalogByKey = await this.#syncSpoolCatalog(inv, snap);
    await this.#syncColorCatalog(inv, snap);
    const brandCanon = this.#brandManufacturerCanonFromSnap(snap);

    const desiredLegacyInv = new Set(
      spools.map((s) => String(s.id ?? "").trim().toLowerCase()),
    );
    const desiredLineTokens = new Set(
      spools.map((s) => {
        const { x, y } = this.#spoolLineXY(s);
        return spoolLineKeyForNote(s.purchase?.orderId, s.filamentId, x, y);
      }),
    );

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const spTotal = spools.length;

    this._log.info(`block: inventory spools — sync ${spTotal} line(s)`);

    let serverList = snap.spools;

    const orphanIds = [];
    for (const row of serverList) {
      const { identityToken, legacyInv } = parseSpoolLineKeyFromNote(row.note);
      const legacyOk =
        legacyInv != null && desiredLegacyInv.has(legacyInv);
      const lineOk =
        identityToken != null && desiredLineTokens.has(identityToken);
      if (legacyOk || lineOk) continue;
      if (legacyInv != null && !desiredLegacyInv.has(legacyInv)) {
        orphanIds.push(Number(row.id));
        continue;
      }
      if (
        identityToken != null &&
        this.#looksLikeManagedLineToken(identityToken) &&
        !lineOk
      ) {
        orphanIds.push(Number(row.id));
      }
    }
    if (orphanIds.length > 0) {
      this._log.info(
        `block: spools — remove ${orphanIds.length} orphan line(s) not in inventory.json`,
      );
      const oph = this.phaseHeartbeat(
        "inventory spools: orphan DELETE",
        orphanIds.length,
      );
      for (const id of orphanIds) {
        try {
          await this.api("DELETE", `/api/v1/inventory/spools/${id}`, undefined);
          oph.bump();
        } catch (e) {
          this._log.warn(`DELETE orphan spool ${id}: ${e?.message ?? e}`);
        }
      }
      oph.end();
      serverList = await this.api("GET", "/api/v1/inventory/spools", undefined);
      if (!Array.isArray(serverList)) {
        throw new Error("Bambuddy GET /inventory/spools did not return an array.");
      }
      snap.spools = serverList;
    }

    /** @type {Map<string, Record<string, unknown>>} */
    const serverRowByLine = new Map();
    /** @type {Map<string, Record<string, unknown>>} */
    const serverRowByLegacy = new Map();
    for (const row of serverList) {
      const { identityToken, legacyInv } = parseSpoolLineKeyFromNote(row.note);
      if (identityToken != null && !serverRowByLine.has(identityToken)) {
        serverRowByLine.set(identityToken, row);
      }
      if (legacyInv != null) {
        if (serverRowByLegacy.has(legacyInv)) {
          this._log.warn(
            `duplicate [inv:${legacyInv}] on server (spool ids ${serverRowByLegacy.get(legacyInv)?.id}, ${row.id}) — using first`,
          );
        } else {
          serverRowByLegacy.set(legacyInv, row);
        }
      }
    }

    this._log.info(
      `block: spools — server ${serverList.length} row(s), ${serverRowByLine.size} line-key index, ${serverRowByLegacy.size} legacy [inv:], ${spTotal} local line(s)`,
    );

    const toPatch = [];
    /** @type {{ canonicalId: string, body: object, idx: number, shortId: string, filamentLabel: string }[]} */
    const toCreate = [];

    for (let i = 0; i < spools.length; i++) {
      const s = spools[i];
      if (typeof s.id !== "string" || s.id.length === 0) {
        throw new Error(
          `inventory.json spools[${i}] missing stable id. Run: node main.js migrate`,
        );
      }
      const f = filamentById.get(s.filamentId);
      if (f == null) {
        throw new Error(`Unknown filamentId on spools[${i}]: ${s.filamentId}`);
      }
      const v = vendorById.get(f.vendorId);
      if (v == null) {
        throw new Error(`Unknown vendorId on filament ${f.id}: ${f.vendorId}`);
      }

      const weight = this.#coreWeightForFilament(f, v);
      const catId = spoolCatalogByKey.get(`${f.vendorId}\0${weight}`) ?? null;

      const createBody = this.#buildCreateBody(v, f, s, catId, brandCanon);
      const patchBody = this.#buildPatchBody(createBody);
      const shortId = s.id.length >= 8 ? s.id.slice(0, 8) : s.id;
      const filamentLabel = (f.name || f.id || "").slice(0, 60);
      const idx1 = i + 1;
      const invKey = String(s.id).trim().toLowerCase();
      const xy = this.#spoolLineXY(s);
      const lineTok = spoolLineKeyForNote(
        s.purchase?.orderId,
        s.filamentId,
        xy.x,
        xy.y,
      );

      const current =
        serverRowByLine.get(lineTok) ?? serverRowByLegacy.get(invKey);
      if (current != null) {
        const bambuddyId = Number(current.id);
        if (this.#needsPatch(current, patchBody)) {
          this._log.debug(
            `spool ${idx1}/${spTotal}: queued PATCH id=${bambuddyId} inventory.id=${invKey.slice(0, 8)}… ${filamentLabel}`,
          );
          toPatch.push({ bambuddyId, patchBody, idx: idx1 });
        } else {
          this._log.debug(
            `spool ${idx1}/${spTotal}: unchanged id=${bambuddyId} inventory.id=${invKey.slice(0, 8)}…`,
          );
          skipped++;
        }
      } else {
        toCreate.push({
          canonicalId: s.id,
          body: createBody,
          idx: idx1,
          shortId,
          filamentLabel,
        });
      }
    }

    this._log.info(
      `block: spools — ${toPatch.length} PATCH, ${toCreate.length} CREATE line(s)`,
    );

    const patchProg = this.phaseHeartbeat(
      "inventory spools: PATCH",
      toPatch.length,
    );
    for (const p of toPatch) {
      this._log.debug(`spool ${p.idx}/${spTotal}: PATCH id=${p.bambuddyId}`);
      await this.api(
        "PATCH",
        `/api/v1/inventory/spools/${p.bambuddyId}`,
        p.patchBody,
      );
      updated++;
      patchProg.bump();
    }
    patchProg.end();

    /** @type {Map<string, { body: object, items: { canonicalId: string, idx: number }[] }>} */
    const createGroups = new Map();
    for (const item of toCreate) {
      const key = this.#stableSpoolCreateKey(item.body);
      let g = createGroups.get(key);
      if (g == null) {
        g = { body: item.body, items: [] };
        createGroups.set(key, g);
      }
      g.items.push({ canonicalId: item.canonicalId, idx: item.idx });
    }

    let bulkHttpCount = 0;
    for (const g of createGroups.values()) {
      bulkHttpCount += Math.ceil(g.items.length / BAMBUDDY_SPOOL_BULK_MAX);
    }
    this._log.info(
      `block: spools — bulk create ${createGroups.size} distinct spool shape(s), ${toCreate.length} line(s) → ${bulkHttpCount} POST /inventory/spools/bulk (≤${BAMBUDDY_SPOOL_BULK_MAX} spools per POST within each shape)`,
    );

    for (const g of createGroups.values()) {
      let offset = 0;
      const items = g.items;
      while (offset < items.length) {
        const n = Math.min(BAMBUDDY_SPOOL_BULK_MAX, items.length - offset);
        const slice = items.slice(offset, offset + n);
        this._log.debug(
          `spool bulk POST quantity=${n} (line index ${slice[0].idx}..${slice[slice.length - 1].idx})`,
        );
        const createdRows = await this.api("POST", "/api/v1/inventory/spools/bulk", {
          spool: g.body,
          quantity: n,
        });
        if (!Array.isArray(createdRows) || createdRows.length !== n) {
          throw new Error(
            `Bambuddy POST /inventory/spools/bulk expected ${n} rows, got ${createdRows?.length}`,
          );
        }
        for (let j = 0; j < n; j++) {
          const row = createdRows[j];
          if (row?.id == null) {
            throw new Error("Bambuddy bulk create returned a row without id");
          }
        }
        created += n;
        offset += n;
      }
    }

    this._log.info(
      `block: push — done (${created} created, ${updated} updated, ${skipped} unchanged)`,
    );
    return { created, updated, skipped };
  }

  async #trackedCleanup() {
    const apply = !this.options.dryRun;
    const serverList = await this.api(
      "GET",
      "/api/v1/inventory/spools",
      undefined,
    );
    if (!Array.isArray(serverList)) {
      throw new Error("Bambuddy GET /inventory/spools did not return an array.");
    }

    const spoolIds = serverList
      .map((row) => Number(row.id))
      .filter((n) => Number.isFinite(n));

    const filamentList = await this.api("GET", "/api/v1/filament-catalog/", undefined);
    const filamentIds = Array.isArray(filamentList)
      ? filamentList
          .map((row) => Number(row.id))
          .filter((n) => Number.isFinite(n))
      : [];

    if (!apply) {
      this._log.info(
        "block: cleanup dry-run — full wipe (no spool/filament bulk-delete in API)",
      );
      this._log.info(
        `  would DELETE ${spoolIds.length} inventory spool(s) (GET /inventory/spools → each id)`,
      );
      for (const id of spoolIds.slice(0, 20)) {
        this._log.info(`    DELETE /api/v1/inventory/spools/${id}`);
      }
      if (spoolIds.length > 20) {
        this._log.info(`    …and ${spoolIds.length - 20} more`);
      }
      this._log.info("  would POST /api/v1/inventory/catalog/reset");
      this._log.info("  would POST /api/v1/inventory/colors/reset");
      this._log.info(
        `  would DELETE ${filamentIds.length} filament-catalog row(s) (per-id DELETE)`,
      );
      for (const id of filamentIds.slice(0, 20)) {
        this._log.info(`    DELETE /api/v1/filament-catalog/${id}`);
      }
      if (filamentIds.length > 20) {
        this._log.info(`    …and ${filamentIds.length - 20} more`);
      }
      return { deleted: 0 };
    }

    this._log.info(
      `block: cleanup — DELETE ${spoolIds.length} spool(s) → reset catalogs → DELETE ${filamentIds.length} filament row(s)`,
    );

    let deletedSpools = 0;
    const delProg = this.phaseHeartbeat(
      "cleanup: inventory spool DELETE",
      spoolIds.length,
    );
    for (const id of spoolIds) {
      try {
        await this.api("DELETE", `/api/v1/inventory/spools/${id}`, undefined);
        deletedSpools++;
        delProg.bump();
      } catch (e) {
        this._log.warn(`DELETE spool ${id}: ${e?.message ?? e}`);
      }
    }
    delProg.end();
    this._log.info(
      `block: cleanup — spools ${deletedSpools}/${spoolIds.length} DELETE (see warn for failures)`,
    );

    this._log.info("block: cleanup — POST /inventory/catalog/reset + /inventory/colors/reset");
    this._log.debug("cleanup: POST /api/v1/inventory/catalog/reset …");
    await this.api("POST", "/api/v1/inventory/catalog/reset", null);
    this._log.debug("cleanup: POST /api/v1/inventory/colors/reset …");
    await this.api("POST", "/api/v1/inventory/colors/reset", null);
    this._log.debug("cleanup: core-weight + color catalog reset complete.");

    let deletedFilaments = 0;
    const filProg = this.phaseHeartbeat(
      "cleanup: filament-catalog DELETE",
      filamentIds.length,
    );
    for (const id of filamentIds) {
      try {
        await this.api("DELETE", `/api/v1/filament-catalog/${id}`, undefined);
        deletedFilaments++;
        filProg.bump();
      } catch (e) {
        this._log.warn(`DELETE filament-catalog ${id}: ${e?.message ?? e}`);
      }
    }
    filProg.end();
    this._log.info(
      `block: cleanup — filaments ${deletedFilaments}/${filamentIds.length} DELETE`,
    );

    this._log.info(
      `block: cleanup — done (${deletedSpools} spool(s) removed; catalogs reset; ${deletedFilaments} filament row(s) removed)`,
    );
    return { deletedSpools, deletedFilaments };
  }

  async push() {
    this.getBaseUrl();
    this.#getApiKey();
    await this.#importFromInventory(INVENTORY_JSON_PATH);
  }

  async cleanup() {
    this.getBaseUrl();
    this.#getApiKey();
    await this.#trackedCleanup();
  }
}
