import fetch from "node-fetch";
import { log } from "./logger";

const CMC_API_BASE_URL = "https://pro-api.coinmarketcap.com/v1";
const DEXSCREENER_API_BASE_URL = "https://api.dexscreener.com";

const CMC_API_KEY = process.env.CMC_API_KEY;

interface CmcListingItem {
  id: number;
  name: string;
  symbol: string;
  slug: string;
  cmc_rank: number;
  quote?: {
    USD?: {
      price: number;
      volume_24h: number;
      market_cap: number;
      percent_change_24h: number;
    }
  }
}

interface CmcListingsResponse {
  status: {
    timestamp: string;
    error_code: number;
    error_message: string | null;
    elapsed: number;
    credit_count: number;
  };
  data: CmcListingItem[];
}

interface DexScreenerBoost {
  url: string;
  chainId: string;
  tokenAddress: string; // This is what we need
}

interface DexScreenerTopBoostsResponse {
  schemaVersion: string;
  boosts: DexScreenerBoost[];
}

/**
 * Fetch “trending” symbols via CoinMarketCap FREE plan.
 * We approximate trending using top market-cap listings (free endpoint):
 *   /v1/cryptocurrency/listings/latest?limit=50&convert=USD
 * Returns an array of symbols (e.g., ["BTC", "ETH", ...]).
 */
export async function getTrendingCoinMarketCapSymbols(limit: number = 50): Promise<string[]> {
  if (!CMC_API_KEY) {
    log("[ERR] [CryptoAPI] Missing CMC_API_KEY in environment.");
    return [];
  }

  const params = new URLSearchParams({
    limit: String(limit),
    convert: "USD",
    sort: "market_cap",
    cryptocurrency_type: "coins",
  });

  const url = `${CMC_API_BASE_URL}/cryptocurrency/listings/latest?${params.toString()}`;

  try {
    log(`[CryptoAPI] Fetching listings from CoinMarketCap (FREE) -> ${url}`);
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "X-CMC_PRO_API_KEY": CMC_API_KEY,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`[ERR] [CryptoAPI] CoinMarketCap listings failed (status ${response.status}): ${errorText}`);
      return [];
    }

    const data = (await response.json()) as CmcListingsResponse;
    if (!data?.data || !Array.isArray(data.data)) {
      log("[WARN] [CryptoAPI] CoinMarketCap response missing 'data' array.");
      return [];
    }

    // Map to uppercase symbols; optionally filter out obvious stablecoins if vuoi.
    const symbols = data.data
      .map(item => item.symbol?.toUpperCase())
      .filter(Boolean) as string[];

    log(`[CryptoAPI] Fetched ${symbols.length} symbols from CoinMarketCap: ${symbols.slice(0, 10).join(", ")}${symbols.length > 10 ? " ..." : ""}`);
    return symbols;
  } catch (error) {
    log(`[ERR] [CryptoAPI] Error fetching CoinMarketCap listings: ${(error as Error).message}`);
    return [];
  }
}

/**
 * Fetches top boosted token addresses from DexScreener.
 * @returns An array of token addresses or an empty array on error.
 */
export async function getTopBoostedDexScreenerAddresses(): Promise<string[]> {
  const endpoint = "/token-boosts/top/v1";
  const url = `${DEXSCREENER_API_BASE_URL}${endpoint}`;

  try {
    log(`[CryptoAPI] Fetching top boosted tokens from DexScreener (${url})...`);
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      const errorText = await response.text();
      log(`[ERR] [CryptoAPI] Failed to fetch from DexScreener (status ${response.status}): ${errorText}`);
      return [];
    }

    const data = (await response.json()) as DexScreenerTopBoostsResponse | DexScreenerBoost[];

    let addresses: string[] = [];
    if (Array.isArray(data)) {
      addresses = (data as DexScreenerBoost[]).map(b => b.tokenAddress).filter(Boolean);
    } else if (data && Array.isArray((data as DexScreenerTopBoostsResponse).boosts)) {
      addresses = (data as DexScreenerTopBoostsResponse).boosts.map(b => b.tokenAddress).filter(Boolean);
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
