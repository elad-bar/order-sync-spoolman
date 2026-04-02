import { BambuddyInventoryManager } from "./bambuddy-inventory-manager.js";
import { BaseInventoryManager } from "./base-inventory-manager.js";
import { MarkdownMigrateManager } from "./markdown-migrate-manager.js";
import { SpoolmanInventoryManager } from "./spoolman-inventory-manager.js";

/** @type {Record<string, (env: NodeJS.ProcessEnv, dryRun: boolean) => BaseInventoryManager>} */
const defaultFactories = {
  bambuddy: (env, dryRun) =>
    new BambuddyInventoryManager({
      baseUrl: env.BAMBUDDY_URL,
      apiKey: env.BAMBUDDY_API_KEY,
      dryRun,
    }),
  spoolman: (env, dryRun) =>
    new SpoolmanInventoryManager({
      baseUrl: env.SPOOLMAN_URL,
      basicUser: env.SPOOLMAN_BASIC_USER,
      basicPass: env.SPOOLMAN_BASIC_PASS,
      dryRun,
    }),
};

export class OperationOrchestrator {
  /**
   * @param {{
   *   system: string;
   *   clean: boolean;
   *   sync: boolean;
   *   execute: boolean;
   *   env: NodeJS.ProcessEnv;
   * }} config
   * @param {typeof defaultFactories} [factories]
   */
  constructor(config, factories = defaultFactories) {
    this.config = config;
    this._managerFactories = factories;
  }

  async initialize() {
    const { system, clean, sync, execute, env } = this.config;
    const dryRun = !execute;
    const needManager = clean || sync;
    if (!needManager) {
      throw new Error("Nothing to do: use --clean and/or --sync");
    }
    const create = this._managerFactories[system];
    if (create == null) {
      throw new Error(
        `Unknown --system ${JSON.stringify(system)} (use bambuddy or spoolman)`,
      );
    }
    const manager = create(env, dryRun);
    if (clean) await manager.cleanup();
    if (sync) {
      await new MarkdownMigrateManager().run();
      await manager.push();
    }
  }
}
