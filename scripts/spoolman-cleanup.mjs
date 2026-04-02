#!/usr/bin/env node
/**
 * Clean Spoolman.
 *
 * Default (no --all): remove orphan catalog rows vs local JSON — empty filaments
 * not in export, then vendors with zero filaments not in vendors.json.
 *
 * With --all: delete **everything** — all spools, then filaments, then vendors
 * (loses weights/history). Then run `spoolman:push` to insert from JSON.
 *
 *   node scripts/spoolman-cleanup.mjs [--dir PATH] [--all] [--dry-run | --apply]
 *
 * Default is dry-run (preview only). Use --apply to execute.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "../lib/env.mjs";
import { nukeSpoolmanData } from "../lib/spoolman-nuke.mjs";
import {
  api,
  fetchPaged,
  filamentVendorId,
  requireSpoolmanBase,
  vendorNameFromFilament,
} from "../lib/spoolman-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

loadDotEnv();

function parseArgs(argv) {
  let dir = join(__dirname, "..", "data", "spoolman");
  let apply = false;
  let all = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--dir" && argv[i + 1]) {
      dir = argv[++i];
    } else if (argv[i] === "--apply") {
      apply = true;
    } else if (argv[i] === "--dry-run") {
      apply = false;
    } else if (argv[i] === "--all") {
      all = true;
    }
  }
  return { dir, apply, all };
}

function exportFilamentKey(vendorName, postName, weight) {
  return `${String(vendorName).toLowerCase()}|${postName}|${weight}`;
}

const base = requireSpoolmanBase();
const { dir, apply, all } = parseArgs(process.argv);

if (all) {
  console.log(
    apply
      ? "Mode: --all APPLY (delete all spools, filaments, vendors)"
      : "Mode: --all dry-run (preview counts only; pass --apply to delete)",
  );
  if (!apply) {
    await nukeSpoolmanData(base, { apply: false });
    console.log("\nPass --apply with --all to wipe the instance.");
    process.exit(0);
  }
  await nukeSpoolmanData(base, { apply: true });
  console.log("Done.");
  process.exit(0);
}

const vendorsJson = JSON.parse(await readFile(join(dir, "vendors.json"), "utf8"));
const filamentsJson = JSON.parse(await readFile(join(dir, "filaments.json"), "utf8"));

const expectedVendorNamesLower = new Set(vendorsJson.map((v) => String(v.name).toLowerCase()));
const expectedFilamentKeys = new Set(
  filamentsJson.map((f) =>
    exportFilamentKey(f.vendor_key, f.post.name, f.post.weight),
  ),
);

const allSpools = await fetchPaged(base, "spool");
const spoolCountByFilamentId = new Map();
for (const s of allSpools) {
  const fid =
    typeof s.filament_id === "number"
      ? s.filament_id
      : s.filament?.id ?? null;
  if (fid == null) continue;
  spoolCountByFilamentId.set(fid, (spoolCountByFilamentId.get(fid) ?? 0) + 1);
}

const allFilaments = await fetchPaged(base, "filament");
const toDeleteFilaments = [];

for (const f of allFilaments) {
  const n = spoolCountByFilamentId.get(f.id) ?? 0;
  if (n > 0) continue;
  const vname = vendorNameFromFilament(f);
  const key = exportFilamentKey(vname, f.name, f.weight);
  if (expectedFilamentKeys.has(key)) continue;
  toDeleteFilaments.push(f);
}

console.log(
  apply
    ? "Mode: APPLY (will delete)"
    : "Mode: dry-run (preview only; pass --apply to delete)",
);

if (toDeleteFilaments.length === 0) {
  console.log("No orphan empty filaments to remove (all zero-spool filaments match export or none empty).");
} else {
  console.log(`Orphan empty filaments (${toDeleteFilaments.length}):`);
  for (const f of toDeleteFilaments) {
    const v = vendorNameFromFilament(f);
    console.log(`  id=${f.id} vendor=${JSON.stringify(v)} name=${JSON.stringify(f.name)} weight=${f.weight}`);
  }
}

if (apply && toDeleteFilaments.length > 0) {
  for (const f of toDeleteFilaments) {
    await api(base, "DELETE", `/api/v1/filament/${f.id}`);
    console.log(`Deleted filament id=${f.id}`);
  }
}

const allVendors = await fetchPaged(base, "vendor");
const filamentIdsToRemove = new Set(toDeleteFilaments.map((f) => f.id));
const filamentCountByVendorId = new Map();
for (const f of allFilaments) {
  if (filamentIdsToRemove.has(f.id)) continue;
  const vid = filamentVendorId(f);
  if (vid == null) continue;
  filamentCountByVendorId.set(vid, (filamentCountByVendorId.get(vid) ?? 0) + 1);
}

const toDeleteVendors = [];
for (const v of allVendors) {
  const fc = filamentCountByVendorId.get(v.id) ?? 0;
  if (fc > 0) continue;
  if (expectedVendorNamesLower.has(String(v.name).toLowerCase())) continue;
  toDeleteVendors.push(v);
}

if (toDeleteVendors.length === 0) {
  console.log("No orphan vendors to remove.");
} else {
  console.log(`Orphan vendors with zero filaments (${toDeleteVendors.length}):`);
  for (const v of toDeleteVendors) {
    console.log(`  id=${v.id} name=${JSON.stringify(v.name)}`);
  }
}

if (apply && toDeleteVendors.length > 0) {
  for (const v of toDeleteVendors) {
    await api(base, "DELETE", `/api/v1/vendor/${v.id}`);
    console.log(`Deleted vendor id=${v.id}`);
  }
}

console.log("Done.");
