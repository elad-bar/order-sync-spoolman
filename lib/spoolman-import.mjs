/**
 * Import vendors → filaments → spools from data/spoolman/*.json (POST only; no PATCH).
 * Spools are incremental: POST only missing instances per (filament_id, amazon_order_id).
 * Run spoolman-cleanup with --all first when you want a clean insert from JSON.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  syncFilamentEntryColorsToPost,
  syncFilamentEntryTempsToPost,
} from "./spoolman-filament-api.mjs";
import {
  amazonOrderIdForSpoolExtra,
  ensureFilamentExtraFieldDefinitions,
  ensureSpoolExtraFieldDefinitions,
  parseAmazonOrderIdFromSpoolApi,
  syncFilamentEntryExtrasToPost,
} from "./spoolman-extra-fields.mjs";
import { api, fetchPaged, filamentDedupeKey, filamentVendorId } from "./spoolman-client.mjs";

function vendorBody(v) {
  return {
    name: v.name,
    comment: v.comment ?? "",
    empty_spool_weight: v.empty_spool_weight ?? 200,
  };
}

function spoolMultisetKey(filamentId, orderId) {
  return `${filamentId}|${orderId}`;
}

export async function importSpoolmanFromJson(base, dir) {
  const vendors = JSON.parse(await readFile(join(dir, "vendors.json"), "utf8"));
  const filaments = JSON.parse(await readFile(join(dir, "filaments.json"), "utf8"));
  const spools = JSON.parse(await readFile(join(dir, "spools.json"), "utf8"));

  const existingVendors = await fetchPaged(base, "vendor");
  const vendorNameToId = new Map();
  const vendorLowerToId = new Map();
  for (const v of existingVendors) {
    if (!vendorNameToId.has(v.name)) vendorNameToId.set(v.name, v.id);
    const low = String(v.name).toLowerCase();
    if (!vendorLowerToId.has(low)) vendorLowerToId.set(low, v.id);
  }

  const vendorIdByKey = new Map();
  for (const v of vendors) {
    const key = v._key ?? v.name;
    let id = vendorNameToId.get(v.name) ?? vendorLowerToId.get(String(v.name).toLowerCase());
    if (id != null) {
      console.log(`Vendor ${v.name} -> id ${id} (existing)`);
    } else {
      const created = await api(base, "POST", "/api/v1/vendor", vendorBody(v));
      id = created.id;
      vendorNameToId.set(v.name, id);
      vendorLowerToId.set(String(v.name).toLowerCase(), id);
      console.log(`Vendor ${v.name} -> id ${id}`);
    }
    vendorIdByKey.set(key, id);
  }

  await ensureFilamentExtraFieldDefinitions(base);

  const existingFilaments = await fetchPaged(base, "filament");
  const filamentDedupe = new Map();
  for (const f of existingFilaments) {
    const vid = filamentVendorId(f);
    const k = filamentDedupeKey(vid, f.name, f.weight);
    if (!filamentDedupe.has(k)) filamentDedupe.set(k, f.id);
  }

  const filamentIdByKey = new Map();
  for (const f of filaments) {
    syncFilamentEntryColorsToPost(f);
    syncFilamentEntryTempsToPost(f);
    syncFilamentEntryExtrasToPost(f);
    const key = f._key;
    const body = { ...f.post };
    const vid = vendorIdByKey.get(f.vendor_key);
    if (vid == null) throw new Error(`Unknown vendor_key: ${f.vendor_key}`);
    body.vendor_id = vid;
    const dedupeKey = filamentDedupeKey(vid, body.name, body.weight);
    let fid = filamentDedupe.get(dedupeKey);
    if (fid != null) {
      console.log(`Filament ${body.name} -> id ${fid} (existing, skipped)`);
    } else {
      const created = await api(base, "POST", "/api/v1/filament", body);
      fid = created.id;
      filamentDedupe.set(dedupeKey, fid);
      console.log(`Filament ${body.name} -> id ${fid}`);
    }
    filamentIdByKey.set(key, fid);
  }

  await ensureSpoolExtraFieldDefinitions(base);

  for (let i = 0; i < spools.length; i++) {
    const s = spools[i];
    if (amazonOrderIdForSpoolExtra(s._source?.order_id) == null) {
      throw new Error(
        `spools.json[${i}]: missing Amazon order id (Order ID is — or empty). ` +
          `Fill Order ID in data/filament-inventory.md, migrate, or use spoolman:reload after fixing data.`,
      );
    }
  }

  const serverSpools = await fetchPaged(base, "spool");
  const serverCount = new Map();
  for (const srv of serverSpools) {
    const oid = parseAmazonOrderIdFromSpoolApi(srv);
    const fid = srv.filament_id ?? srv.filament?.id;
    if (oid == null || fid == null) continue;
    const k = spoolMultisetKey(fid, oid);
    serverCount.set(k, (serverCount.get(k) || 0) + 1);
  }

  const desiredByKey = new Map();
  for (const s of spools) {
    const fid = filamentIdByKey.get(s._filament_key);
    if (fid == null) throw new Error(`Unknown _filament_key: ${s._filament_key}`);
    const oid = amazonOrderIdForSpoolExtra(s._source.order_id);
    const k = spoolMultisetKey(fid, oid);
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
    console.log(`Spools ${k}: creating ${need} (already ${have} on server, ${count} in JSON)`);
    for (let i = 0; i < need; i++) {
      const body = { ...template.post };
      body.filament_id = fid;
      await api(base, "POST", "/api/v1/spool", body);
      spoolN++;
    }
  }

  console.log(`Done: ${spoolN} spool(s) created.`);
  return { spoolN };
}
