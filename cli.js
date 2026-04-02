#!/usr/bin/env node
/**
 * Single entry: dispatch by subcommand.
 *
 *   node cli.js <command> [options]
 *
 *   migrate   — data/amazon-filament-inventory.md → data/inventory.json
 *   push      — data/inventory.json → Spoolman API
 *   cleanup   — Spoolman full wipe preview [--dry-run | --apply]
 *   reload    — cleanup --apply, then push
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import dotenv from "dotenv";

import { MarkdownMigrateManager } from "./managers/markdown-migrate-manager.js";
import { SpoolmanInventoryManager } from "./managers/spoolman-inventory-manager.js";

const __cliDir = dirname(fileURLToPath(import.meta.url));
const PROJECT_ENV_PATH = join(__cliDir, ".env");

function loadProjectEnv(envPath = PROJECT_ENV_PATH) {
  if (!existsSync(envPath)) return;
  dotenv.config({ path: envPath, override: false });
}

function usage() {
  console.log(`Usage: node cli.js <command> [options]

Commands:
  migrate    data/amazon-filament-inventory.md → data/inventory.json

  push       Push data/inventory.json to Spoolman API

  cleanup    Preview or delete all spools, filaments, vendors
             [--dry-run | --apply]

  reload     cleanup --apply, then push (extra flags forwarded to both steps)

Examples:
  node cli.js migrate
  node cli.js push
  node cli.js cleanup --dry-run
  node cli.js reload
`);
}

function isMainModule() {
  const entry = process.argv[1];
  if (entry == null) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

async function main() {
  const cmd = process.argv[2];
  const sub = process.argv.slice(3);

  if (cmd == null || cmd === "-h" || cmd === "--help") {
    usage();
    process.exit(cmd == null ? 1 : 0);
  }

  if (cmd === "migrate") {
    await new MarkdownMigrateManager().run(sub);
    return;
  }

  if (cmd === "push" || cmd === "cleanup" || cmd === "reload") {
    loadProjectEnv();
    const spoolman = new SpoolmanInventoryManager({
      baseUrl: process.env.SPOOLMAN_URL,
      basicUser: process.env.SPOOLMAN_BASIC_USER,
      basicPass: process.env.SPOOLMAN_BASIC_PASS,
    });
    if (cmd === "push") await spoolman.push(sub);
    else if (cmd === "cleanup") await spoolman.cleanup(sub);
    else {
      await spoolman.cleanup(["--apply", ...sub]);
      await spoolman.push(sub);
    }
    return;
  }

  console.error(`Unknown command: ${cmd}\n`);
  usage();
  process.exit(1);
}

if (isMainModule()) {
  main().catch((e) => {
    console.error(e?.message ?? e);
    process.exit(1);
  });
}
