/**
 * Console logger (Winston). Control verbosity with LOG_LEVEL or DEBUG=1.
 *
 * - **info** — phase blocks and summaries (default).
 * - **debug** — every HTTP request/response plus detailed reconciliation lines.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import winston from "winston";

const __libDir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__libDir, "..", ".env"), override: false });

/** @returns {string} */
function resolveLevel() {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (
    raw &&
    ["error", "warn", "info", "http", "verbose", "debug", "silly"].includes(raw)
  ) {
    return raw;
  }
  if (process.env.DEBUG === "1" || process.env.DEBUG === "true") {
    return "debug";
  }
  return "info";
}

const level = resolveLevel();

const baseFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: "HH:mm:ss.SSS" }),
  winston.format.printf((info) => {
    const scope = info.scope ? `${info.scope} ` : "";
    return `${info.timestamp} ${info.level}: ${scope}${info.message}`;
  }),
);

export const logger = winston.createLogger({
  level,
  format: baseFormat,
  transports: [
    new winston.transports.Console({
      stderrLevels: ["error"],
    }),
  ],
});

/**
 * @param {string} [scope] e.g. `bambuddy`, `main`
 * @returns {winston.Logger}
 */
export function getLogger(scope) {
  return scope ? logger.child({ scope }) : logger;
}
