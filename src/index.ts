import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { TwitchClient, TwitchBotConfig } from "./utils/twitchAuth";
import { QuestionService, QuestionTokenInfo } from "./services/questionService";
import { TokenStoreService } from "./services/tokenStoreService";
import {
  TokenCandidate,
  getCoinMarketCapTokens,
  getCoinGeckoTrendingTokens,
  getTopBoostedDexScreenerAddresses,
} from "./utils/cryptoApi";
import { log, initLogger } from "./utils/logger";

const CONFIG_PATH = path.resolve(process.cwd(), "chatbot.config.json");

const DEXSCREENER_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const MARKET_DATA_CACHE_TTL_MS = 10 * 60 * 1000; // don't burn API credits every question
const RECENT_TOKEN_MEMORY = 6; // don't ask about the same token twice in a row
const TOKEN_PICK_ATTEMPTS = 10;

interface AppConfig {
  twitch: {
    bot1: TwitchBotConfig;
    bot2: TwitchBotConfig;
  };
}

function loadAppConfig(): AppConfig | null {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      log(`[ERR] [Main] Configuration file not found at ${CONFIG_PATH}. Please create it.`);
      return null;
    }
    const rawConfig = fs.readFileSync(CONFIG_PATH, "utf8");
    const config = JSON.parse(rawConfig) as AppConfig;
    if (!config.twitch || !config.twitch.bot1 || !config.twitch.bot2) {
      log("[ERR] [Main] Invalid configuration structure in chatbot.config.json. Missing twitch.bot1 or twitch.bot2.");
      return null;
    }
    return config;
  } catch (error) {
    log(`[ERR] [Main] Failed to load or parse chatbot.config.json: ${(error as Error).message}`);
    return null;
  }
}

/** Cached market data so each question doesn't cost an API call. */
class CandidateCache {
  private candidates: TokenCandidate[] = [];
  private fetchedAt = 0;

  constructor(
    private readonly label: string,
    private readonly fetcher: () => Promise<TokenCandidate[]>
  ) {}

  async get(): Promise<TokenCandidate[]> {
    const now = Date.now();
    if (now - this.fetchedAt > MARKET_DATA_CACHE_TTL_MS) {
      const fresh = await this.fetcher();
      if (fresh.length > 0) {
        this.candidates = fresh;
        this.fetchedAt = now;
      } else {
        log(`[WARN] [Main] ${this.label} returned no candidates; keeping ${this.candidates.length} stale ones.`);
      }
    }
    return this.candidates;
  }
}

async function main() {
  initLogger();
  log("[Main] Starting AIR3 Twitch Crypto Bot...");

  const appConfig = loadAppConfig();
  if (!appConfig) {
    log("[FATAL] [Main] Exiting due to configuration load failure.");
    process.exit(1);
  }

  const deltaTMinMinutes = parseInt(process.env.DELTA_T_MIN_MINUTES || "5", 10);
  const deltaTMaxMinutes = parseInt(process.env.DELTA_T_MAX_MINUTES || "60", 10);

  if (isNaN(deltaTMinMinutes) || isNaN(deltaTMaxMinutes) || deltaTMinMinutes <= 0 || deltaTMaxMinutes <= deltaTMinMinutes) {
    log("[FATAL] [Main] Invalid DELTA_T_MIN_MINUTES or DELTA_T_MAX_MINUTES in .env file.");
    process.exit(1);
  }
  log(`[Main] Question interval: ${deltaTMinMinutes} to ${deltaTMaxMinutes} minutes.`);

  const twitchBot1 = new TwitchClient(appConfig.twitch.bot1, "bot1");
  const twitchBot2 = new TwitchClient(appConfig.twitch.bot2, "bot2");
  const bots: TwitchClient[] = [];

  try { await twitchBot1.start(); bots.push(twitchBot1); } catch (e) { log(`[ERR] [Main] Failed to start Bot 1: ${(e as Error).message}`); }
  try { await twitchBot2.start(); bots.push(twitchBot2); } catch (e) { log(`[ERR] [Main] Failed to start Bot 2: ${(e as Error).message}`); }

  if (bots.length === 0) {
    log("[FATAL] [Main] No Twitch bots started. Exiting.");
    process.exit(1);
  }

  if (bots.length === 2) {
    const b1 = bots[0], b2 = bots[1];
    const id1 = b1.getUserId(), id2 = b2.getUserId();
    log(`[Main] Bot identities -> ${b1.getIdentifier()} userId=${id1}, ${b2.getIdentifier()} userId=${id2}`);

    if (!id1 || !id2) {
      log("[FATAL] [Main] One of the bots does not have a userId after start(). Check tokens/scopes.");
      process.exit(1);
    }
    if (id1 === id2) {
      log("[FATAL] [Main] bot1 and bot2 share the SAME Twitch userId. Re-authorize using TWO different Twitch accounts (scope: user:write:chat).");
      process.exit(1);
    }
  } else {
    log(`[Main] ${bots.length} Twitch bot(s) initialized (not both). Round-robin will operate over the available bot(s).`);
  }

  const questionService = new QuestionService();
  await questionService.loadQuestions();

  const tokenStoreService = new TokenStoreService();

  const cmcCache = new CandidateCache("CoinMarketCap", () => getCoinMarketCapTokens(50));
  const coingeckoCache = new CandidateCache("CoinGecko trending", () => getCoinGeckoTrendingTokens());

  async function refreshDexScreenerTokens() {
    log("[MainLoop] Refreshing DexScreener token list...");
    const newAddresses = await getTopBoostedDexScreenerAddresses();
    if (newAddresses.length > 0) {
      tokenStoreService.addContractAddresses(newAddresses);
    } else {
      log("[MainLoop] No new tokens fetched from DexScreener this cycle.");
    }
  }
  await refreshDexScreenerTokens();
  setInterval(refreshDexScreenerTokens, DEXSCREENER_REFRESH_INTERVAL_MS);

  // ---- Token sources, rotated per question with fallback to the others ----
  type SourceName = "coingecko" | "coinmarketcap" | "dexscreener";
  const sourceCycle: SourceName[] = ["coingecko", "coinmarketcap", "dexscreener"];
  let sourceIndex = 0;
  const recentTokens: string[] = [];

  function rememberToken(identifier: string) {
    recentTokens.push(identifier.toUpperCase());
    if (recentTokens.length > RECENT_TOKEN_MEMORY) recentTokens.shift();
  }

  function pickFresh(candidates: TokenCandidate[]): TokenCandidate | null {
    if (candidates.length === 0) return null;
    for (let i = 0; i < TOKEN_PICK_ATTEMPTS; i++) {
      const candidate = candidates[Math.floor(Math.random() * candidates.length)];
      if (!recentTokens.includes(candidate.identifier.toUpperCase())) return candidate;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  async function candidatesFrom(source: SourceName): Promise<TokenCandidate[]> {
    switch (source) {
      case "coingecko":
        return coingeckoCache.get();
      case "coinmarketcap":
        return cmcCache.get();
      case "dexscreener": {
        if (tokenStoreService.getStoreSize() < tokenStoreService.getMinStoreThreshold()) {
          await refreshDexScreenerTokens();
        }
        const address = tokenStoreService.getNextContractAddress();
        return address ? [{ identifier: address, type: "address", source: "dexscreener" }] : [];
      }
    }
  }

  async function pickNextToken(): Promise<TokenCandidate | null> {
    // Start from the scheduled source, fall back through the rest
    for (let i = 0; i < sourceCycle.length; i++) {
      const source = sourceCycle[(sourceIndex + i) % sourceCycle.length];
      const candidate = pickFresh(await candidatesFrom(source));
      if (candidate) {
        sourceIndex = (sourceIndex + i + 1) % sourceCycle.length;
        log(`[MainLoop] Token from ${source}: ${candidate.identifier}${candidate.change24h !== undefined ? ` (24h ${candidate.change24h.toFixed(1)}%)` : ""}`);
        return candidate;
      }
    }
    return null;
  }

  // ---- Round-robin across the available bots ----
  let nextBotIndex = 0;
  function pickNextBot(): TwitchClient {
    const bot = bots[nextBotIndex];
    nextBotIndex = (nextBotIndex + 1) % bots.length;
    return bot;
  }

  async function questionLoop() {
    try {
      const waitTimeMinutes = Math.random() * (deltaTMaxMinutes - deltaTMinMinutes) + deltaTMinMinutes;
      log(`[MainLoop] Next question in ${waitTimeMinutes.toFixed(2)} minutes.`);
      await new Promise(resolve => setTimeout(resolve, waitTimeMinutes * 60 * 1000));

      // ~1 question in 6 is a general/market one with no specific token —
      // real chatters don't only ask about single coins.
      let tokenInfo: QuestionTokenInfo | undefined;
      if (Math.random() >= 1 / 6) {
        const candidate = await pickNextToken();
        if (candidate) {
          tokenInfo = {
            identifier: candidate.identifier,
            type: candidate.type,
            change24h: candidate.change24h,
          };
          rememberToken(candidate.identifier);
        } else {
          log("[MainLoop] No token available from any source; asking a general question.");
        }
      }

      const question = await questionService.getFormattedQuestion(tokenInfo);

      if (question && bots.length > 0) {
        const selectedBot = pickNextBot();
        log(`[MainLoop] Sending with ${selectedBot.getIdentifier()} [userId=${selectedBot.getUserId()}] -> "${question}"`);
        await selectedBot.sendMessage(question);
      } else if (!question) {
        log("[MainLoop] No question generated. Skipping.");
      }
    } catch (error) {
      log(`[ERR] [MainLoop] Error: ${(error as Error).message}`);
    } finally {
      setImmediate(questionLoop);
    }
  }

  questionLoop();
}

main().catch(err => {
  log(`[FATAL] [Main] Unhandled startup error: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) { log(err.stack); }
  process.exit(1);
});
