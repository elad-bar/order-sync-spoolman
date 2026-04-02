/**
 * Entire Spoolman domain: HTTP client, push from inventory.json, cleanup/nuke.
 * All behavior lives on {@link SpoolmanInventoryManager} via main.js (`--system spoolman`).
 *
 * HTTP: shared read/write **Bottleneck** reservoirs on {@link BaseInventoryManager}; **429** retries and
 * **X-RateLimit-** pacing match {@link BambuddyInventoryManager} (architecture §9–§10).
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { EM_DASH } from "../models/common.js";
import {
  FILAMENT_EXTRA_BED_KEY,
  FILAMENT_EXTRA_FIELD_DEFINITIONS,
  FILAMENT_EXTRA_NOZZLE_KEY,
  SPOOL_EXTRA_AMAZON_ORDER_KEY,
  SPOOL_EXTRA_FIELD_DEFINITIONS,
} from "../models/spoolman.js";
import { BaseInventoryManager } from "./base-inventory-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVENTORY_JSON_PATH = join(__dirname, "..", "data", "inventory.json");

export class SpoolmanInventoryManager extends BaseInventoryManager {
  constructor(options = {}) {
    super({ ...options, inventorySystem: "spoolman" });
  }

  /** @param {boolean} [jsonBody] */
  httpHeaders(jsonBody = false) {
    const h = {
      Accept: "application/json",
      ...(jsonBody ? { "Content-Type": "application/json" } : {}),
    };
    const u = this.options.basicUser;
    const p = this.options.basicPass;
    if (u != null && p != null) {
      h.Authorization = `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
    }
    return h;
  }

  async #fetchPaged(resource) {
    const all = [];
    let offset = 0;
    const limit = 200;
    while (true) {
      const chunk = await this.api(
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

  #filamentVendorId(f) {
    return f.vendor_id ?? f.vendor?.id;
  }

  #vendorNameFromFilament(f) {
    return f?.vendor?.name ?? "";
  }

  #filamentDedupeKey(vendorId, name, weight) {
    return `${vendorId}|${name}|${weight}`;
  }

  #amazonOrderIdForSpoolExtra(orderIdCell) {
    const s = (orderIdCell ?? "").trim();
    if (!s || s === "-" || s === EM_DASH) return null;
    return s;
  }

  #parseAmazonOrderIdFromSpoolApi(spool) {
    const raw = spool?.extra?.[SPOOL_EXTRA_AMAZON_ORDER_KEY];
    if (raw == null || raw === "") return null;
    try {
      const v = JSON.parse(raw);
      return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
    } catch {
      return null;
    }
  }

  #buildFilamentExtraFromMinsMax(emin, emax, bmin, bmax) {
    const o = {};
    if (Number.isFinite(emin) && Number.isFinite(emax)) {
      o[FILAMENT_EXTRA_NOZZLE_KEY] = JSON.stringify([emin, emax]);
    }
    if (Number.isFinite(bmin) && Number.isFinite(bmax)) {
      o[FILAMENT_EXTRA_BED_KEY] = JSON.stringify([bmin, bmax]);
    }
    return o;
  }

  async #ensureFilamentExtraFieldDefinitions() {
    const existing = await this.api("GET", "/api/v1/field/filament");
    if (!Array.isArray(existing)) return;
    const keys = new Set(existing.map((f) => f.key));
    for (const { key, body } of FILAMENT_EXTRA_FIELD_DEFINITIONS) {
      if (keys.has(key)) continue;
      await this.api("POST", `/api/v1/field/filament/${key}`, body);
      this._log.debug(`registered filament extra field: ${key}`);
    }
  }

  async #ensureSpoolExtraFieldDefinitions() {
    const existing = await this.api("GET", "/api/v1/field/spool");
    if (!Array.isArray(existing)) return;
    const keys = new Set(existing.map((f) => f.key));
    for (const { key, body } of SPOOL_EXTRA_FIELD_DEFINITIONS) {
      if (keys.has(key)) continue;
      await this.api("POST", `/api/v1/field/spool/${key}`, body);
      this._log.debug(`registered spool extra field: ${key}`);
    }
  }

  #normHex(h) {
    const s = String(h || "").trim().replace(/^#/, "");
    return s ? s.toUpperCase() : "";
  }

  #applyColorsToSpoolmanPost(post, colors, color_direction) {
    const norm = (Array.isArray(colors) ? colors : [])
      .map((c) => this.#normHex(c))
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

  #syncFilamentEntryColorsToPost(entry) {
    if (!entry?.post) return;
    if (Array.isArray(entry.colors) && entry.colors.length > 0) {
      this.#applyColorsToSpoolmanPost(entry.post, entry.colors, entry.color_direction ?? null);
    }
  }

  #syncFilamentEntryTempsToPost(entry) {
    if (!entry?.post) return;
    const e = entry.settings_extruder_temp_min;
    const b = entry.settings_bed_temp_min;
    if (Number.isFinite(e)) entry.post.settings_extruder_temp = e;
    if (Number.isFinite(b)) entry.post.settings_bed_temp = b;
  }

  #syncFilamentEntryExtrasToPost(entry) {
    if (!entry?.post) return;
    const delta = this.#buildFilamentExtraFromMinsMax(
      entry.settings_extruder_temp_min,
      entry.settings_extruder_temp_max,
      entry.settings_bed_temp_min,
      entry.settings_bed_temp_max,
    );
    if (Object.keys(delta).length === 0) return;
    entry.post.extra = { ...(entry.post.extra || {}), ...delta };
  }

  #spoolmanFilamentDisplayName(canonicalName) {
    const n = String(canonicalName || "").trim();
    return n.length > 64 ? n.slice(0, 64) : n;
  }

  #filamentCommentForSpoolman(f) {
    const parts = [`Product: ${f.productTitle}`, `Color: ${f.colors.description}`];
    const et = f.settings.extruderTempC;
    const bt = f.settings.bedTempC;
    if (et && Number.isFinite(et.min) && Number.isFinite(et.max)) {
      parts.push(`Nozzle ${et.min}–${et.max} °C`);
    }
    if (bt && Number.isFinite(bt.min) && Number.isFinite(bt.max)) {
      parts.push(`Bed ${bt.min}–${bt.max} °C`);
    }
    return parts.join(" | ").slice(0, 2000);
  }

  #canonicalFilamentToImportEntry(f) {
    const ex = f.settings.extruderTempC;
    const bed = f.settings.bedTempC;
    const post = {
      name: this.#spoolmanFilamentDisplayName(f.name),
      vendor_id: null,
      material: f.material,
      price: 0,
      density: f.density,
      diameter: f.diameterMm,
      weight: f.weightNetGrams,
      spool_weight: f.spoolWeightGrams,
      comment: this.#filamentCommentForSpoolman(f),
    };

    const entry = {
      _key: f.id,
      vendor_key: f.vendorId,
      colors: f.colors.hexes,
      color_direction: f.colors.direction,
      settings_extruder_temp_min: ex?.min ?? null,
      settings_extruder_temp_max: ex?.max ?? null,
      settings_bed_temp_min: bed?.min ?? null,
      settings_bed_temp_max: bed?.max ?? null,
      post,
    };

    this.#syncFilamentEntryColorsToPost(entry);
    this.#syncFilamentEntryTempsToPost(entry);
    this.#syncFilamentEntryExtrasToPost(entry);
    return entry;
  }

  #vendorBodyFromCanonical(v) {
    return {
      name: v.name,
      comment: "",
      empty_spool_weight: v.emptySpoolWeightGrams ?? 200,
    };
  }

  #spoolCommentFromPurchase(p) {
    const bits = [];
    if (p.orderId && p.orderId !== EM_DASH) bits.push(`Order: ${p.orderId}`);
    if (p.placedDate) bits.push(`Placed: ${p.placedDate}`);
    if (p.status) bits.push(`Status: ${p.status}`);
    return bits.join(" | ").slice(0, 1900);
  }

  #spoolMultisetKey(filamentId, orderId) {
    return `${filamentId}|${orderId}`;
  }

  async #importFromInventory(inventoryPath) {
    const inv = JSON.parse(await readFile(inventoryPath, "utf8"));
    const vendors = inv.vendors;
    const filaments = inv.filaments.map((f) => this.#canonicalFilamentToImportEntry(f));
    const ORDER_KEY = SPOOL_EXTRA_AMAZON_ORDER_KEY;

    const spools = inv.spools.map((s, i) => {
      if (this.#amazonOrderIdForSpoolExtra(s.purchase?.orderId) == null) {
        throw new Error(
          `inventory.json spools[${i}]: missing Amazon order id (Order ID is — or empty). ` +
            `Fix ${inventoryPath} and re-run migrate.`,
        );
      }
      const post = {
        filament_id: null,
        comment: this.#spoolCommentFromPurchase(s.purchase),
        price: s.purchase.unitPriceUsd,
        extra: {
          [ORDER_KEY]: JSON.stringify(this.#amazonOrderIdForSpoolExtra(s.purchase.orderId)),
        },
      };
      return {
        _filament_key: s.filamentId,
        _source: { order_id: s.purchase.orderId },
        post,
      };
    });

    const existingVendors = await this.#fetchPaged("vendor");
    const vendorNameToId = new Map();
    const vendorLowerToId = new Map();
    for (const v of existingVendors) {
      if (!vendorNameToId.has(v.name)) vendorNameToId.set(v.name, v.id);
      const low = String(v.name).toLowerCase();
      if (!vendorLowerToId.has(low)) vendorLowerToId.set(low, v.id);
    }

    const vendorIdByKey = new Map();
    for (const v of vendors) {
      const key = v.id;
      let id = vendorNameToId.get(v.name) ?? vendorLowerToId.get(String(v.name).toLowerCase());
      if (id != null) {
        this._log.debug(`vendor ${v.name} -> id ${id} (existing)`);
      } else {
        const created = await this.api("POST", "/api/v1/vendor", this.#vendorBodyFromCanonical(v));
        id = created.id;
        vendorNameToId.set(v.name, id);
        vendorLowerToId.set(String(v.name).toLowerCase(), id);
        this._log.debug(`vendor ${v.name} -> id ${id} (created)`);
      }
      vendorIdByKey.set(key, id);
    }

    await this.#ensureFilamentExtraFieldDefinitions();

    const existingFilaments = await this.#fetchPaged("filament");
    const filamentDedupe = new Map();
    for (const f of existingFilaments) {
      const vid = this.#filamentVendorId(f);
      const k = this.#filamentDedupeKey(vid, f.name, f.weight);
      if (!filamentDedupe.has(k)) filamentDedupe.set(k, f.id);
    }

    const filamentIdByKey = new Map();
    for (const f of filaments) {
      const key = f._key;
      const body = { ...f.post };
      const vid = vendorIdByKey.get(f.vendor_key);
      if (vid == null) throw new Error(`Unknown vendor_key: ${f.vendor_key}`);
      body.vendor_id = vid;
      const dedupeKey = this.#filamentDedupeKey(vid, body.name, body.weight);
      let fid = filamentDedupe.get(dedupeKey);
      if (fid != null) {
        this._log.debug(`filament ${body.name} -> id ${fid} (existing)`);
      } else {
        const created = await this.api("POST", "/api/v1/filament", body);
        fid = created.id;
        filamentDedupe.set(dedupeKey, fid);
        this._log.debug(`filament ${body.name} -> id ${fid} (created)`);
      }
      filamentIdByKey.set(key, fid);
    }

    await this.#ensureSpoolExtraFieldDefinitions();

    const serverSpools = await this.#fetchPaged("spool");
    const serverCount = new Map();
    for (const srv of serverSpools) {
      const oid = this.#parseAmazonOrderIdFromSpoolApi(srv);
      const fid = srv.filament_id ?? srv.filament?.id;
      if (oid == null || fid == null) continue;
      const k = this.#spoolMultisetKey(fid, oid);
      serverCount.set(k, (serverCount.get(k) || 0) + 1);
    }

    const desiredByKey = new Map();
    for (const s of spools) {
      const fid = filamentIdByKey.get(s._filament_key);
      if (fid == null) throw new Error(`Unknown filamentId: ${s._filament_key}`);
      const oid = this.#amazonOrderIdForSpoolExtra(s._source.order_id);
      const k = this.#spoolMultisetKey(fid, oid);
      if (!desiredByKey.has(k)) {
        desiredByKey.set(k, { count: 0, template: s });
      }
      desiredByKey.get(k).count += 1;
    }

    let spoolN = 0;
    const sortedEntries = [...desiredByKey.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [k, { count, template }] of sortedEntries) {
      const have = serverCount.get(k) || 0;
      const need = Math.max(0, count - have);
      if (need === 0) continue;
      const fid = filamentIdByKey.get(template._filament_key);
      this._log.debug(
        `spools ${k}: creating ${need} (server ${have}, desired ${count} in JSON)`,
      );
      for (let i = 0; i < need; i++) {
        const body = { ...template.post };
        body.filament_id = fid;
        await this.api("POST", "/api/v1/spool", body);
        spoolN++;
      }
    }

    this._log.info(`push done: ${spoolN} spool(s) created`);
    return { spoolN };
  }

  #logNukeBreakdown(vendors, filaments, spools, apply) {
    const tag = apply ? "Deleting" : "Would delete";
    const byId = (a, b) => a.id - b.id;
    const filamentById = new Map(filaments.map((f) => [f.id, f]));

    const vSorted = [...vendors].sort(byId);
    this._log.info(`${tag} vendors (${vSorted.length})`);
    for (const v of vSorted) {
      this._log.info(`  id=${v.id}  name=${JSON.stringify(v.name ?? "")}`);
    }

    const fSorted = [...filaments].sort(byId);
    this._log.info(`${tag} filaments (${fSorted.length})`);
    for (const f of fSorted) {
      const vn = f.vendor?.name;
      const vendorBit =
        vn != null
          ? `vendor=${JSON.stringify(vn)}`
          : `vendor_id=${f.vendor_id ?? "?"}`;
      this._log.info(
        `  id=${f.id}  name=${JSON.stringify(f.name ?? "")}  weight=${f.weight ?? "?"}g  ${vendorBit}`,
      );
    }

    const sSorted = [...spools].sort(byId);
    this._log.info(`${tag} spools (${sSorted.length})`);
    for (const s of sSorted) {
      const fid =
        typeof s.filament_id === "number"
          ? s.filament_id
          : s.filament?.id ?? "?";
      const meta = s.filament?.name ?? filamentById.get(Number(fid))?.name;
      const metaBit = meta != null ? `  ${JSON.stringify(meta)}` : "";
      this._log.info(`  id=${s.id}  filament_id=${fid}${metaBit}`);
    }
  }

  async #nukeSpoolmanData({ apply = false } = {}) {
    const spools = await this.#fetchPaged("spool");
    const filaments = await this.#fetchPaged("filament");
    const vendors = await this.#fetchPaged("vendor");

    this._log.info(
      `cleanup ${apply ? "apply" : "dry-run"}: ${spools.length} spool(s), ${filaments.length} filament(s), ${vendors.length} vendor(s)`,
    );

    this.#logNukeBreakdown(vendors, filaments, spools, apply);

    if (!apply) {
      return { spools: spools.length, filaments: filaments.length, vendors: vendors.length };
    }

    const delTotal =
      spools.length + filaments.length + vendors.length;
    const hb = this.phaseHeartbeat("cleanup: Spoolman DELETE", delTotal);

    for (const s of spools) {
      await this.api("DELETE", `/api/v1/spool/${s.id}`);
      hb.bump();
    }
    for (const f of filaments) {
      await this.api("DELETE", `/api/v1/filament/${f.id}`);
      hb.bump();
    }
    for (const v of vendors) {
      await this.api("DELETE", `/api/v1/vendor/${v.id}`);
      hb.bump();
    }
    hb.end();

    this._log.info("cleanup apply: all spools, filaments, vendors deleted");
    return { spools: spools.length, filaments: filaments.length, vendors: vendors.length };
  }

  async #runCleanupLogic(opts) {
    const { apply } = opts;
    this._log.info(
      apply
        ? "cleanup mode: apply (delete all spools, filaments, vendors)"
        : "cleanup mode: dry-run (list below; pass --apply to delete)",
    );
    if (!apply) {
      await this.#nukeSpoolmanData({ apply: false });
      this._log.info("pass --apply to wipe the instance");
      return;
    }
    await this.#nukeSpoolmanData({ apply: true });
    this._log.info("cleanup finished");
  }

  async push() {
    this.getBaseUrl();
    await this.#importFromInventory(INVENTORY_JSON_PATH);
  }

  async cleanup() {
    this.getBaseUrl();
    const apply = !this.options.dryRun;
    await this.#runCleanupLogic({ apply });
  }
}
