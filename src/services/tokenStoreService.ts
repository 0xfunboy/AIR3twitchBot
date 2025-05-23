import fs from "fs/promises";
import path from "path";
import { log } from "../utils/logger";

const PERSISTENCE_FILE_PATH = path.resolve(process.cwd(), "discovered_dex_tokens.json");
const MAX_STORE_SIZE = 200; // Max number of addresses to keep in store to prevent bloating
const MIN_STORE_THRESHOLD = 10; // If store size drops below this, might trigger more frequent refills

export class TokenStoreService {
  private contractAddresses: string[] = [];
  private currentIndex = 0; // For round-robin retrieval

  constructor() {
    this.loadPersistedAddresses().catch(err => {
      log(`[WARN] [TokenStoreService] Failed to load persisted addresses on init: ${err.message}`);
    });
  }

  private async loadPersistedAddresses(): Promise<void> {
    try {
      const data = await fs.readFile(PERSISTENCE_FILE_PATH, "utf8");
      const parsedAddresses = JSON.parse(data);
      if (Array.isArray(parsedAddresses) && parsedAddresses.every(addr => typeof addr === 'string')) {
        this.contractAddresses = parsedAddresses.slice(0, MAX_STORE_SIZE); // Ensure not too large
        log(`[TokenStoreService] Loaded ${this.contractAddresses.length} addresses from persistence.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        log("[TokenStoreService] No persistence file found. Starting with an empty store.");
      } else {
        log(`[ERR] [TokenStoreService] Error loading persisted addresses: ${(error as Error).message}`);
      }
    }
  }

  private async persistAddresses(): Promise<void> {
    try {
      await fs.writeFile(PERSISTENCE_FILE_PATH, JSON.stringify(this.contractAddresses, null, 2));
      log(`[TokenStoreService] Persisted ${this.contractAddresses.length} addresses.`);
    } catch (error) {
      log(`[ERR] [TokenStoreService] Error persisting addresses: ${(error as Error).message}`);
    }
  }

  /**
   * Adds new contract addresses to the store, avoiding duplicates and managing store size.
   * @param newAddresses - Array of new contract addresses.
   */
  public addContractAddresses(newAddresses: string[]): void {
    let addedCount = 0;
    for (const addr of newAddresses) {
      if (!this.contractAddresses.includes(addr)) {
        if (this.contractAddresses.length >= MAX_STORE_SIZE) {
          this.contractAddresses.shift(); // Remove oldest if store is full
        }
        this.contractAddresses.push(addr);
        addedCount++;
      }
    }
    if (addedCount > 0) {
        log(`[TokenStoreService] Added ${addedCount} new unique addresses. Store size: ${this.contractAddresses.length}`);
        this.persistAddresses(); // Persist after adding
    }
  }

  /**
   * Gets the next contract address from the store using round-robin.
   * @returns A contract address string or null if the store is empty.
   */
  public getNextContractAddress(): string | null {
    if (this.contractAddresses.length === 0) {
      return null;
    }
    if (this.currentIndex >= this.contractAddresses.length) {
      this.currentIndex = 0; // Reset to start
    }
    const address = this.contractAddresses[this.currentIndex];
    this.currentIndex++;
    return address;
  }

  public getStoreSize(): number {
    return this.contractAddresses.length;
  }

  public getMinStoreThreshold(): number {
    return MIN_STORE_THRESHOLD;
  }
}