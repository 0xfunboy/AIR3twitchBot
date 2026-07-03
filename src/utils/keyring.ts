import { log } from "./logger";

const COOLDOWN_RATE_LIMIT_MS = 10 * 60 * 1000; // 429: back off 10 minutes
const COOLDOWN_UNAUTHORIZED_MS = 6 * 60 * 60 * 1000; // 401/403: likely bad/exhausted key
const COOLDOWN_GENERIC_MS = 60 * 1000;
const MAX_NUMBERED_KEYS = 32;

interface KeyState {
  key: string;
  label: string;
  disabledUntil: number;
}

/**
 * Round-robin pool of API keys. Every call to next() advances the cursor so
 * consecutive requests spread across keys; keys that fail with 429/401/403
 * are put in cooldown and skipped until they recover.
 */
export class ApiKeyRing {
  private states: KeyState[] = [];
  private cursor = 0;

  constructor(private readonly name: string, keys: string[]) {
    const unique = [...new Set(keys.map(k => k.trim()).filter(Boolean))];
    this.states = unique.map((key, i) => ({
      key,
      label: `${name}#${i + 1}`,
      disabledUntil: 0,
    }));
    log(`[KeyRing] ${name}: loaded ${this.states.length} key(s).`);
  }

  /**
   * Collects keys from BASE, BASE2..BASE32 env vars, plus any legacy aliases.
   */
  static fromEnv(name: string, baseVar: string, legacyVars: string[] = []): ApiKeyRing {
    const keys: string[] = [];
    const base = process.env[baseVar];
    if (base) keys.push(base);
    for (let i = 2; i <= MAX_NUMBERED_KEYS; i++) {
      const v = process.env[`${baseVar}${i}`];
      if (v) keys.push(v);
    }
    for (const legacy of legacyVars) {
      const v = process.env[legacy];
      if (v) keys.push(v);
    }
    return new ApiKeyRing(name, keys);
  }

  size(): number {
    return this.states.length;
  }

  /**
   * Returns the next usable key (round-robin). If every key is cooling down,
   * returns the one that unlocks soonest rather than giving up.
   */
  next(): { key: string; label: string } | null {
    if (this.states.length === 0) return null;
    const now = Date.now();
    for (let i = 0; i < this.states.length; i++) {
      const state = this.states[(this.cursor + i) % this.states.length];
      if (state.disabledUntil <= now) {
        this.cursor = (this.cursor + i + 1) % this.states.length;
        return { key: state.key, label: state.label };
      }
    }
    const soonest = this.states.reduce((a, b) => (a.disabledUntil <= b.disabledUntil ? a : b));
    log(`[WARN] [KeyRing] ${this.name}: all keys cooling down, reusing ${soonest.label}.`);
    return { key: soonest.key, label: soonest.label };
  }

  reportFailure(key: string, httpStatus: number): void {
    const state = this.states.find(s => s.key === key);
    if (!state) return;
    const cooldownMs =
      httpStatus === 429
        ? COOLDOWN_RATE_LIMIT_MS
        : httpStatus === 401 || httpStatus === 403
          ? COOLDOWN_UNAUTHORIZED_MS
          : COOLDOWN_GENERIC_MS;
    state.disabledUntil = Date.now() + cooldownMs;
    log(
      `[WARN] [KeyRing] ${this.name}: ${state.label} in cooldown for ${Math.round(cooldownMs / 60000)} min (HTTP ${httpStatus}).`
    );
  }
}
