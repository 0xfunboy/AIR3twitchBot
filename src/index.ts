import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import path from "path";
import { TwitchClient, TwitchBotConfig } from "./utils/twitchAuth";
import { QuestionService, TokenIdentifierType } from "./services/questionService";
import { TokenStoreService } from "./services/tokenStoreService";
import { getTrendingCoinGeckoSymbols, getTopBoostedDexScreenerAddresses } from "./utils/cryptoApi";
import { log, initLogger } from "./utils/logger";

const CONFIG_PATH = path.resolve(process.cwd(), "chatbot.config.json");

interface AppConfig {
  twitch: {
    bot1: TwitchBotConfig;
    bot2: TwitchBotConfig;
  };
}

function loadAppConfig(): AppConfig | null { /* ... (come prima) ... */ 
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

const DEXSCREENER_REFRESH_INTERVAL_MS = 15 * 60 * 1000; // Refresh DexScreener list every 15 minutes
let useDexScreenerNext = false; // Start with CoinGecko perhaps

async function main() {
  initLogger();
  log("[Main] Starting AIR3 Twitch Crypto Bro Bot...");

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

  try { await twitchBot1.start(); bots.push(twitchBot1); } catch (e) { log(`[ERR] Failed to start Bot 1: ${(e as Error).message}`); }
  try { await twitchBot2.start(); bots.push(twitchBot2); } catch (e) { log(`[ERR] Failed to start Bot 2: ${(e as Error).message}`); }

  if (bots.length === 0) {
    log("[FATAL] [Main] No Twitch bots started. Exiting.");
    process.exit(1);
  }
  log(`[Main] ${bots.length} Twitch bot(s) initialized.`);

  const questionService = new QuestionService();
  await questionService.loadQuestions();

  const tokenStoreService = new TokenStoreService();

  async function refreshDexScreenerTokens() {
    log("[MainLoop] Refreshing DexScreener token list...");
    const newAddresses = await getTopBoostedDexScreenerAddresses();
    if (newAddresses.length > 0) {
      tokenStoreService.addContractAddresses(newAddresses);
    } else {
      log("[MainLoop] No new tokens fetched from DexScreener this cycle.");
    }
  }
  // Initial fetch and set up periodic refresh for DexScreener
  await refreshDexScreenerTokens();
  setInterval(refreshDexScreenerTokens, DEXSCREENER_REFRESH_INTERVAL_MS);


  async function questionLoop() {
    let tokenInfo: { identifier: string; type: TokenIdentifierType } | undefined = undefined;
    let question: string | null = null;

    try {
      const waitTimeMinutes = Math.random() * (deltaTMaxMinutes - deltaTMinMinutes) + deltaTMinMinutes;
      const waitTimeMs = waitTimeMinutes * 60 * 1000;
      log(`[MainLoop] Next question in ${waitTimeMinutes.toFixed(2)} minutes. Alternating source: ${useDexScreenerNext ? 'DexScreener' : 'CoinGecko'}`);
      await new Promise(resolve => setTimeout(resolve, waitTimeMs));

      if (useDexScreenerNext) {
        let dexTokenAddress = tokenStoreService.getNextContractAddress();
        if (!dexTokenAddress && tokenStoreService.getStoreSize() < tokenStoreService.getMinStoreThreshold()) {
            log("[MainLoop] DexScreener store low/empty, attempting immediate refresh before selecting token...");
            await refreshDexScreenerTokens(); // Try to refill
            dexTokenAddress = tokenStoreService.getNextContractAddress();
        }

        if (dexTokenAddress) {
          tokenInfo = { identifier: dexTokenAddress, type: "address" };
          log(`[MainLoop] Using DexScreener token: ${dexTokenAddress}`);
        } else {
          log("[MainLoop] No DexScreener token available, falling back to CoinGecko for this turn.");
          // Fallback to CoinGecko if DexScreener fails or has no tokens
          const cgSymbols = await getTrendingCoinGeckoSymbols();
          if (cgSymbols.length > 0) {
            const symbol = cgSymbols[Math.floor(Math.random() * cgSymbols.length)];
            tokenInfo = { identifier: symbol, type: "ticker" };
            log(`[MainLoop] Using CoinGecko token (fallback): $${symbol}`);
          }
        }
      } else { // Use CoinGecko
        const cgSymbols = await getTrendingCoinGeckoSymbols();
        if (cgSymbols.length > 0) {
          const symbol = cgSymbols[Math.floor(Math.random() * cgSymbols.length)];
          tokenInfo = { identifier: symbol, type: "ticker" };
          log(`[MainLoop] Using CoinGecko token: $${symbol}`);
        } else {
            log("[MainLoop] No CoinGecko token available, trying DexScreener as fallback for this turn.");
            let dexTokenAddress = tokenStoreService.getNextContractAddress();
            if (dexTokenAddress) {
                tokenInfo = { identifier: dexTokenAddress, type: "address" };
                log(`[MainLoop] Using DexScreener token (fallback): ${dexTokenAddress}`);
            }
        }
      }
      
      // Toggle for next iteration
      useDexScreenerNext = !useDexScreenerNext;

      // Get question based on whether we have tokenInfo or not
      question = await questionService.getFormattedQuestion(tokenInfo);

      if (question && bots.length > 0) {
        const selectedBot = bots[Math.floor(Math.random() * bots.length)];
        log(`[MainLoop] Selected bot (${selectedBot === twitchBot1 ? 'bot1' : 'bot2'}) to ask: "${question}"`);
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