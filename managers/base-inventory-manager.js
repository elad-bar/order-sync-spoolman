/**
 * Base contract for backend inventory managers (push + cleanup).
 * Spoolman: see spoolman-inventory-manager.js
 *
 * @typedef {Record<string, unknown>} ManagerConfig
 */

export class BaseInventoryManager {
  /**
   * @param {ManagerConfig} options
   */
  constructor(options = {}) {
    this.options = options;
  }

  /** @param {string[]} _argv */
  async push(_argv) {
    throw new Error("push() must be implemented by subclass");
  }

  /** @param {string[]} _argv */
  async cleanup(_argv) {
    throw new Error("cleanup() must be implemented by subclass");
  }
}
