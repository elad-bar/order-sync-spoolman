#!/usr/bin/env node
/**
 * 2) Push data/spoolman/*.json to Spoolman: POST vendors/filaments; spools are
 *    incremental (only missing physical spools per filament_id + amazon_order_id).
 *    Vendors/filaments: create if missing; filaments dedupe on existing catalog.
 *    Spool extra `amazon_order_id` must exist on server spools—one-time
 *    inventory:migrate + spoolman:reload if upgrading from spools without it.
 *
 *   node scripts/export-to-spoolman.mjs [--dir PATH]
 *   npm run spoolman:push
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "../lib/env.mjs";
import { importSpoolmanFromJson } from "../lib/spoolman-import.mjs";
import { requireSpoolmanBase } from "../lib/spoolman-client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

loadDotEnv();

function parseDirArg() {
  let dir = join(__dirname, "..", "data", "spoolman");
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i] === "--dir" && process.argv[i + 1]) {
      dir = process.argv[++i];
    }
  }
  return dir;
}

const base = requireSpoolmanBase();
const dir = parseDirArg();

await importSpoolmanFromJson(base, dir);
