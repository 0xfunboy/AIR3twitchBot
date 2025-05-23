import fetch from "node-fetch";
import { log } from "./logger";

const COINGECKO_API_BASE_URL = "https://api.coingecko.com/api/v3";
const COINGECKO_PRO_API_BASE_URL = "https://pro-api.coingecko.com/api/v3";
const DEXSCREENER_API_BASE_URL = "https://api.dexscreener.com";

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY;

interface CoinGeckoTrendingCoinItem {
  id: string;
  coin_id: number; // Not directly used, but part of response
  name: string;
  symbol: string; // This is what we primarily want (e.g., "BTC")
  market_cap_rank: number | null;
  thumb: string;
  small: string;
  large: string;
  slug: string;
  price_btc: number;
  score: number; // Indicates trending rank
}

interface CoinGeckoTrendingResponse {
  coins: { item: CoinGeckoTrendingCoinItem }[]; // API nests the coin item under "item"
  nfts: any[]; // Ignoring NFTs for now
  categories: any[]; // Ignoring categories for now
}

interface DexScreenerBoost {
  url: string;
  chainId: string;
  tokenAddress: string; // This is what we need
  // ... other fields we might ignore for now
}

interface DexScreenerTopBoostsResponse {
  schemaVersion: string;
  boosts: DexScreenerBoost[];
}


/**
 * Fetches trending coins from CoinGecko.
 * @returns A promise that resolves to an array of trending coin symbols (e.g., ["BTC", "ETH"]) or an empty array on error.
 */
export async function getTrendingCoinGeckoSymbols(): Promise<string[]> {
  const endpoint = "/search/trending";
  const baseUrl = COINGECKO_API_KEY ? COINGECKO_PRO_API_BASE_URL : COINGECKO_API_BASE_URL;
  const url = `${baseUrl}${endpoint}`;
  
  const headers: { [key: string]: string } = { accept: 'application/json' };
  if (COINGECKO_API_KEY) {
    headers["x-cg-pro-api-key"] = COINGECKO_API_KEY;
  }

  try {
    log(`[CryptoAPI] Fetching trending coins from CoinGecko (${url})...`);
    const response = await fetch(url, { headers });
    if (!response.ok) {
      const errorText = await response.text();
      log(`[ERR] [CryptoAPI] Failed to fetch trending from CoinGecko (status ${response.status}): ${errorText}`);
      return [];
    }
    const data = (await response.json()) as CoinGeckoTrendingResponse;
    if (data && data.coins) {
      const symbols = data.coins.map(coinWrapper => coinWrapper.item.symbol.toUpperCase());
      log(`[CryptoAPI] Successfully fetched ${symbols.length} trending CoinGecko symbols: ${symbols.join(', ')}`);
      return symbols;
    }
    log("[WARN] [CryptoAPI] No coins found in CoinGecko trending response.");
    return [];
  } catch (error) {
    log(`[ERR] [CryptoAPI] Error fetching trending CoinGecko symbols: ${(error as Error).message}`);
    return [];
  }
}

/**
 * Fetches top boosted token addresses from DexScreener.
 * @returns A promise that resolves to an array of token addresses or an empty array on error.
 */
export async function getTopBoostedDexScreenerAddresses(): Promise<string[]> {
  const endpoint = "/token-boosts/top/v1"; // As per your request
  const url = `${DEXSCREENER_API_BASE_URL}${endpoint}`;

  try {
    log(`[CryptoAPI] Fetching top boosted tokens from DexScreener (${url})...`);
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      const errorText = await response.text();
      log(`[ERR] [CryptoAPI] Failed to fetch from DexScreener (status ${response.status}): ${errorText}`);
      return [];
    }
    const data = (await response.json()) as DexScreenerTopBoostsResponse; // Assuming this is the structure
    
    // Based on your example, the response is an array directly
    // Let's adjust if the structure is actually { "boosts": [] }
    let addresses: string[] = [];
    if (data && Array.isArray(data)) { // If response is directly an array of boosts
        addresses = (data as unknown as DexScreenerBoost[]).map(boost => boost.tokenAddress).filter(addr => !!addr);
    } else if (data && data.boosts && Array.isArray(data.boosts)) { // If response is { "boosts": [...] }
        addresses = data.boosts.map(boost => boost.tokenAddress).filter(addr => !!addr);
    }

    if (addresses.length > 0) {
      log(`[CryptoAPI] Successfully fetched ${addresses.length} DexScreener token addresses.`);
      return addresses;
    }
    log("[WARN] [CryptoAPI] No token addresses found in DexScreener response or response format unexpected.");
    return [];
  } catch (error) {
    log(`[ERR] [CryptoAPI] Error fetching DexScreener addresses: ${(error as Error).message}`);
    return [];
  }
}