/**
 * Base contract for backend inventory managers (push + cleanup).
 * Shared: Bottleneck reservoirs, HTTP gateway (`api`), rate-limit / 429 handling, dry-run skeleton, phase heartbeat.
 *
 * Subclasses implement {@link BaseInventoryManager#httpHeaders}.
 * Optional override: {@link BaseInventoryManager#dryRunStubResponse} (default: POST → `{ id }`).
 *
 * @typedef {"bambuddy" | "spoolman"} InventorySystem
 * @typedef {Record<string, unknown> & {
 *   dryRun?: boolean;
 *   inventorySystem: InventorySystem;
 * }} ManagerConfig
 */

import Bottleneck from "bottleneck";

import { getLogger } from "../lib/logger.js";

/**
 * Per-system caps (docs/BAMBUDDY-SYNC-ARCHITECTURE.md §6 ballpark). Adjust here only.
 * @type {Record<InventorySystem, { readPerMinute: number; writePerMinute: number; reservoirRefreshMs: number }>}
 */
const INVENTORY_LIMITER_CONFIG = {
  bambuddy: {
    readPerMinute: 100,
    writePerMinute: 30,
    reservoirRefreshMs: 1_000,
  },
  spoolman: {
    readPerMinute: 100,
    writePerMinute: 30,
    reservoirRefreshMs: 1_000,
  },
};

/** Architecture §10 — shared by concrete managers. */
const RATE_LIMIT_429_MAX_RETRIES = 8;
const RATE_LIMIT_FALLBACK_WAIT_MS = 65_000;

/** @type {Record<InventorySystem, string>} */
const BASE_URL_ENV_HINT = {
  bambuddy: "BAMBUDDY_URL (e.g. http://host:8000)",
  spoolman: "SPOOLMAN_URL (e.g. from project .env when running main.js)",
};

export class BaseInventoryManager {
  /** @type {Bottleneck} */
  readLimiter;
  /** @type {Bottleneck} */
  writeLimiter;
  /** @type {import("winston").Logger} */
  _log;

  #dryRunSeq = 0;

  /**
   * @param {ManagerConfig} options Must include `inventorySystem` (subclasses set it before calling super).
   */
  constructor(options = {}) {
    const system = options.inventorySystem;
    if (system !== "bambuddy" && system !== "spoolman") {
      throw new Error(
        "BaseInventoryManager requires options.inventorySystem: bambuddy | spoolman",
      );
    }
    const cfg = INVENTORY_LIMITER_CONFIG[system];
    this.readLimiter = this.#makeReservoirLimiter(
      cfg.readPerMinute,
      cfg.reservoirRefreshMs,
    );
    this.writeLimiter = this.#makeReservoirLimiter(
      cfg.writePerMinute,
      cfg.reservoirRefreshMs,
    );
    this.options = options;
    this._log = getLogger(system);
  }

  /**
   * Synthetic ids for dry-run POST stubs (negative, monotonic).
   * @returns {number}
   */
  allocateDryRunId() {
    this.#dryRunSeq -= 1;
    return this.#dryRunSeq;
  }

  /**
   * @param {number} perMinute
   * @param {number} reservoirRefreshMs
   * @returns {Bottleneck}
   */
  #makeReservoirLimiter(perMinute, reservoirRefreshMs) {
    return new Bottleneck({
      maxConcurrent: perMinute,
      reservoir: perMinute,
      reservoirRefreshAmount: perMinute,
      reservoirRefreshInterval: reservoirRefreshMs,
    });
  }

  /** Origin only, no trailing slash. */
  getBaseUrl() {
    const raw = this.options.baseUrl;
    const base = typeof raw === "string" ? raw.replace(/\/$/, "") : "";
    if (!base) {
      this._log.error(
        `base URL missing: set ${BASE_URL_ENV_HINT[this.options.inventorySystem]}`,
      );
      process.exit(2);
    }
    return base;
  }

  /**
   * §9 — ~30s info during long loops.
   * @returns {{ bump: (n?: number) => void, end: (extra?: string) => void }}
   */
  phaseHeartbeat(label, total) {
    const startMs = Date.now();
    let done = 0;
    if (total <= 0) {
      return {
        bump() {},
        end() {},
      };
    }
    const iv = setInterval(() => {
      const elapsedS = Math.round((Date.now() - startMs) / 1000);
      this._log.info(`${label}: ${done}/${total} (${elapsedS}s elapsed)`);
    }, 30_000);
    return {
      bump: (n = 1) => {
        done += n;
      },
      end: (extra = "") => {
        clearInterval(iv);
        const elapsedS = Math.round((Date.now() - startMs) / 1000);
        const tail = extra ? ` ${extra}` : "";
        this._log.info(`${label}: done ${done}/${total} (${elapsedS}s)${tail}`);
      },
    };
  }

  /**
   * @param {boolean} jsonBody
   * @returns {Record<string, string>}
   */
  httpHeaders(jsonBody) {
    throw new Error(
      `${this.options.inventorySystem}: httpHeaders() must be implemented by subclass`,
    );
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} body
   * @returns {unknown}
   */
  dryRunStubResponse(method, path, body) {
    if (method === "POST") {
      return { id: this.allocateDryRunId() };
    }
    return null;
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} body
   */
  async api(method, path, body) {
    if (this.options.dryRun && method !== "GET") {
      this._log.debug(`dry-run: skipping ${method} ${path}`);
      return this.dryRunStubResponse(method, path, body);
    }

    const limiter = method === "GET" ? this.readLimiter : this.writeLimiter;
    return limiter.schedule(() => this.#scheduledFetch(method, path, body));
  }

  /**
   * @param {Headers} headers
   * @param {string} name
   * @returns {number | null}
   */
  #headerInt(headers, name) {
    const v = headers.get(name);
    if (v == null || v === "") return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }

  /**
   * @param {Headers} headers
   * @returns {number | null}
   */
  #rateLimitResetMs(headers) {
    const n = this.#headerInt(headers, "x-ratelimit-reset");
    if (n == null) return null;
    return n > 1e12 ? n : n * 1000;
  }

  /**
   * @param {Headers} headers
   * @returns {number}
   */
  #waitMsAfter429(headers) {
    const ra = headers.get("retry-after");
    if (ra) {
      const seconds = parseInt(ra, 10);
      if (!Number.isNaN(seconds) && seconds >= 0) {
        return Math.max(seconds * 1000, 250);
      }
      const d = Date.parse(ra);
      if (!Number.isNaN(d)) {
        return Math.max(d - Date.now(), 250);
      }
    }
    const resetMs = this.#rateLimitResetMs(headers);
    if (resetMs != null) {
      return Math.max(resetMs - Date.now() + 100, 1000);
    }
    return 5000;
  }

  /**
   * @param {Headers} headers
   */
  async #paceAfterSuccess(headers) {
    const rem = this.#headerInt(headers, "x-ratelimit-remaining");
    const resetMs = this.#rateLimitResetMs(headers);

    if (rem !== null && rem <= 0) {
      if (resetMs != null) {
        const waitMs = Math.ceil(resetMs - Date.now()) + 100;
        if (waitMs > 0) {
          this._log.debug(
            `rate limit: X-RateLimit-Remaining=${rem}, waiting ${waitMs}ms until reset`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
        }
      } else {
        this._log.debug(
          `rate limit: X-RateLimit-Remaining=${rem} but no X-RateLimit-Reset; waiting ${RATE_LIMIT_FALLBACK_WAIT_MS}ms`,
        );
        await new Promise((r) => setTimeout(r, RATE_LIMIT_FALLBACK_WAIT_MS));
      }
    }
  }

  /**
   * One logical request including 429 retries, under a single limiter job (architecture §10).
   * @param {string} method
   * @param {string} path
   * @param {unknown} body
   */
  async #scheduledFetch(method, path, body) {
    const base = this.getBaseUrl();
    const url = `${base}${path}`;
    let attempt = 0;

    while (true) {
      let bodyNote = "";
      if (body != null) {
        const s = JSON.stringify(body);
        bodyNote =
          s.length <= 400
            ? ` body=${s}`
            : ` bodyLen=${s.length} preview=${s.slice(0, 200)}…`;
      }
      const retryNote = attempt > 0 ? ` (retry ${attempt})` : "";
      this._log.debug(`→ ${method} ${url}${retryNote}${bodyNote}`);

      const res = await fetch(url, {
        method,
        headers: this.httpHeaders(body != null),
        body: body != null ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      const rem = res.headers.get("x-ratelimit-remaining");
      const rst = res.headers.get("x-ratelimit-reset");
      this._log.debug(
        `← ${res.status} ${method} ${path} respLen=${text.length}` +
          (rem != null ? ` X-RateLimit-Remaining=${rem}` : "") +
          (rst != null ? ` X-RateLimit-Reset=${rst}` : ""),
      );

      if (res.status === 429 && attempt < RATE_LIMIT_429_MAX_RETRIES) {
        const waitMs = this.#waitMsAfter429(res.headers);
        this._log.warn(
          `HTTP 429 Too Many Requests, waiting ${waitMs}ms before retry (${attempt + 1}/${RATE_LIMIT_429_MAX_RETRIES})`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        attempt++;
        continue;
      }

      if (!res.ok) {
        throw new Error(`${method} ${url} -> ${res.status}: ${text}`);
      }

      await this.#paceAfterSuccess(res.headers);

      if (!text) return null;
      return JSON.parse(text);
    }
  }

  async push() {
    throw new Error("push() must be implemented by subclass");
  }

  async cleanup() {
    throw new Error("cleanup() must be implemented by subclass");
  }
}
