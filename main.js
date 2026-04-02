#!/usr/bin/env node
/**
 * Unified entry (architecture §13): load `.env`, argv → config,
 * {@link OperationOrchestrator#initialize}.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { getLogger } from "./lib/logger.js";
import { MarkdownMigrateManager } from "./managers/markdown-migrate-manager.js";
import { OperationOrchestrator } from "./managers/operation-orchestrator.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dir, ".env");
const log = getLogger("main");

/** @param {string[]} argv */
function parseArgv(argv) {
  let system = "spoolman";
  let clean = false;
  let sync = false;
  let execute = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--system") {
      const v = argv[++i];
      if (v !== "spoolman" && v !== "bambuddy") {
        log.error("--system requires spoolman or bambuddy");
        process.exit(1);
      }
      system = v;
    } else if (a === "--clean") clean = true;
    else if (a === "--sync") sync = true;
    else if (a === "--execute") execute = true;
    else if (a === "-h" || a === "--help") return { help: true };
    else {
      log.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return { system, clean, sync, execute, help: false };
}

function usage() {
  log.info(`Usage:
  node main.js migrate
  node main.js [--system spoolman|bambuddy] [--clean] [--sync] [--execute]

migrate    Markdown → data/inventory.json only (no .env / no HTTP).

Otherwise at least one of --clean or --sync.

--system spoolman|bambuddy   default spoolman
--clean      Backend cleanup first
--sync       Markdown migrate then push
--execute    Live mutations and destructive cleanup (omit for dry-run rehearsal)

Examples:
  node main.js migrate
  node main.js --sync --system bambuddy
  node main.js --clean --sync --execute --system bambuddy
`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "migrate") {
    if (argv.length !== 1) {
      log.error("usage: node main.js migrate (no extra arguments)");
      process.exit(1);
    }
    await new MarkdownMigrateManager().run();
    return;
  }

  const parsed = parseArgv(argv);
  if (parsed.help) {
    usage();
    return;
  }
  if (!parsed.clean && !parsed.sync) {
    usage();
    process.exit(1);
  }
  if (existsSync(ENV_PATH)) dotenv.config({ path: ENV_PATH, override: false });

  const env = { ...process.env };
  await new OperationOrchestrator({
    system: parsed.system,
    clean: parsed.clean,
    sync: parsed.sync,
    execute: parsed.execute,
    env,
  }).initialize();
}

main().catch((e) => {
  log.error(e?.message ?? String(e));
  process.exit(1);
});
