#!/usr/bin/env node
/**
 * 1) Migrate from data/filament-inventory.md → data/spoolman/*.json (no API).
 *
 *   node scripts/migrate-from-md.mjs [--markdown PATH] [--out DIR]
 *   npm run inventory:migrate
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { migrateFromMarkdown } from "../lib/inventory-md.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  let markdown = join(__dirname, "..", "data", "filament-inventory.md");
  let out = join(__dirname, "..", "data", "spoolman");
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--markdown" && argv[i + 1]) {
      markdown = argv[++i];
    } else if (argv[i] === "--out" && argv[i + 1]) {
      out = argv[++i];
    }
  }
  return { markdown, out };
}

const { markdown, out } = parseArgs(process.argv);

try {
  const { vendorsJson, filamentsJson, spools, errors } = await migrateFromMarkdown(
    markdown,
    out,
  );

  console.log(
    `Wrote ${out}: ${vendorsJson.length} vendors, ${filamentsJson.length} filaments, ${spools.length} spools`,
  );
  if (errors.length > 0) {
    console.warn(`Skipped ${errors.length} row(s); see ${join(out, "export_meta.json")}`);
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
