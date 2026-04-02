import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROJECT_ROOT = join(__dirname, "..");
const DOTENV_CANDIDATES = [
  join(PROJECT_ROOT, ".env"),
  join(PROJECT_ROOT, "scripts", ".env"),
];

/**
 * Load env via [dotenv](https://github.com/motdotla/dotenv): first existing file among
 * project root `.env`, then `scripts/.env`. Does not override existing `process.env`.
 * Pass `filePath` for a single file.
 *
 * Note: plain `dotenv.config()` only reads `process.cwd()/.env`; this repo supports
 * `scripts/.env` when the root file is absent.
 */
export function loadDotEnv(filePath) {
  const paths =
    filePath != null ? [filePath] : DOTENV_CANDIDATES.filter((p) => existsSync(p));
  for (const p of paths) {
    if (!existsSync(p)) continue;
    dotenv.config({ path: p, override: false });
    return;
  }
}
