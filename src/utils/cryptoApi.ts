import fetch from "node-fetch";
import { log } from "./logger";
import { ApiKeyRing } from "./keyring";

const CMC_API_BASE_URL = "https://pro-api.coinmarketcap.com/v1";
const COINGECKO_API_BASE_URL = "https://api.coingecko.com/api/v3";
const DEXSCREENER_API_BASE_URL = "https://api.dexscreener.com";

// Symbols that make for boring/noise questions (stables & wrapped assets)
const EXCLUDED_SYMBOLS = new Set([
  "USDT", "USDC", "DAI", "TUSD", "FDUSD", "USDE", "USDS", "PYUSD", "USD1", "BUSD",
  "WBTC", "WETH", "STETH", "WSTETH", "WBETH", "CBBTC", "WBNB",
]);

export type TokenSource = "coinmarketcap" | "coingecko" | "dexscreener";

export interface TokenCandidate {
  identifier: string; // ticker symbol (e.g. "SOL") or contract address
  type: "ticker" | "address";
  name?: string;
  change24h?: number; // 24h % change when the source provides it
  source: TokenSource;
}

// Key rings are created lazily so dotenv.config() has definitely run first.
let cmcKeys: ApiKeyRing | null = null;
let coingeckoKeys: ApiKeyRing | null = null;

function getCmcKeys(): ApiKeyRing {
  if (!cmcKeys) cmcKeys = ApiKeyRing.fromEnv("CoinMarketCap", "COINMARKETCAP_KEY", ["CMC_API_KEY"]);
  return cmcKeys;
}

function getCoingeckoKeys(): ApiKeyRing {
  if (!coingeckoKeys) coingeckoKeys = ApiKeyRing.fromEnv("CoinGecko", "COINGECKO_KEY", ["CG_API_KEY"]);
  return coingeckoKeys;
}

/**
 * GETs a JSON endpoint using the key ring: tries up to ring.size() keys,
 * reporting failures so rate-limited keys rotate out automatically.
 */
async function fetchJsonWithRing<T>(
  ring: ApiKeyRing,
  url: string,
  headersForKey: (key: string) => Record<string, string>,
  label: string
): Promise<T | null> {
  const attempts = Math.max(1, ring.size());
  for (let attempt = 0; attempt < attempts; attempt++) {
    const entry = ring.next();
    if (!entry) {
      log(`[ERR] [CryptoAPI] ${label}: no API keys configured.`);
      return null;
    }
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json", ...headersForKey(entry.key) },
      });
      if (response.ok) {
        return (await response.json()) as T;
      }
      const errorText = await response.text();
      log(`[WARN] [CryptoAPI] ${label} failed with ${entry.label} (status ${response.status}): ${errorText.slice(0, 200)}`);
      ring.reportFailure(entry.key, response.status);
      // Non-key-related errors (4xx other than auth/ratelimit, 5xx) won't be
      // fixed by rotating, so stop retrying.
      if (![401, 403, 429].includes(response.status)) return null;
    } catch (error) {
      log(`[ERR] [CryptoAPI] ${label} network error with ${entry.label}: ${(error as Error).message}`);
      return null;
    }
  }
  log(`[ERR] [CryptoAPI] ${label}: all keys exhausted.`);
  return null;
}

interface CmcListingItem {
  id: number;
  name: string;
  symbol: string;
  cmc_rank: number;
  quote?: {
    USD?: {
      price: number;
      volume_24h: number;
      market_cap: number;
      percent_change_24h: number;
    };
  };
}

interface CmcListingsResponse {
  status: { error_code: number; error_message: string | null };
  data: CmcListingItem[];
}

/**
 * Top market-cap coins from CoinMarketCap (free-plan endpoint), with 24h
 * change so the question engine can react to movers.
 */
export async function getCoinMarketCapTokens(limit: number = 50): Promise<TokenCandidate[]> {
  const params = new URLSearchParams({
    limit: String(limit),
    convert: "USD",
    sort: "market_cap",
    cryptocurrency_type: "coins",
  });
  const url = `${CMC_API_BASE_URL}/cryptocurrency/listings/latest?${params.toString()}`;

  const data = await fetchJsonWithRing<CmcListingsResponse>(
    getCmcKeys(),
    url,
    key => ({ "X-CMC_PRO_API_KEY": key }),
    "CoinMarketCap listings"
  );
  if (!data?.data || !Array.isArray(data.data)) return [];

  const candidates = data.data
    .filter(item => item.symbol && !EXCLUDED_SYMBOLS.has(item.symbol.toUpperCase()))
    .map<TokenCandidate>(item => ({
      identifier: item.symbol.toUpperCase(),
      type: "ticker",
      name: item.name,
      change24h: item.quote?.USD?.percent_change_24h,
      source: "coinmarketcap",
    }));

  log(`[CryptoAPI] CoinMarketCap: ${candidates.length} candidates (${candidates.slice(0, 8).map(c => c.identifier).join(", ")}...).`);
  return candidates;
}

interface CoinGeckoTrendingResponse {
  coins?: Array<{
    item?: {
      id: string;
      name: string;
      symbol: string;
      market_cap_rank?: number;
      data?: {
        price_change_percentage_24h?: { usd?: number };
      };
    };
  }>;
}

/**
 * Coins trending on CoinGecko right now — these are what people are actually
 * searching for, which makes the questions feel timely.
 */
export async function getCoinGeckoTrendingTokens(): Promise<TokenCandidate[]> {
  const url = `${COINGECKO_API_BASE_URL}/search/trending`;

  const data = await fetchJsonWithRing<CoinGeckoTrendingResponse>(
    getCoingeckoKeys(),
    url,
    key => ({ "x-cg-demo-api-key": key }),
    "CoinGecko trending"
  );
  if (!data?.coins || !Array.isArray(data.coins)) return [];

  const candidates = data.coins
    .map(c => c.item)
    .filter((item): item is NonNullable<typeof item> => Boolean(item?.symbol))
    .filter(item => !EXCLUDED_SYMBOLS.has(item.symbol.toUpperCase()))
    .map<TokenCandidate>(item => ({
      identifier: item.symbol.toUpperCase(),
      type: "ticker",
      name: item.name,
      change24h: item.data?.price_change_percentage_24h?.usd,
      source: "coingecko",
    }));

  log(`[CryptoAPI] CoinGecko trending: ${candidates.length} candidates (${candidates.map(c => c.identifier).join(", ")}).`);
  return candidates;
}

interface DexScreenerBoost {
  url: string;
  chainId: string;
  tokenAddress: string;
}

interface DexScreenerTopBoostsResponse {
  schemaVersion: string;
  boosts: DexScreenerBoost[];
}

/**
 * Top boosted token addresses from DexScreener (no API key required).
 */
export async function getTopBoostedDexScreenerAddresses(): Promise<string[]> {
  const url = `${DEXSCREENER_API_BASE_URL}/token-boosts/top/v1`;

  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      const errorText = await response.text();
      log(`[ERR] [CryptoAPI] DexScreener failed (status ${response.status}): ${errorText.slice(0, 200)}`);
      return [];
    }

    const data = (await response.json()) as DexScreenerTopBoostsResponse | DexScreenerBoost[];

    let addresses: string[] = [];
    if (Array.isArray(data)) {
      addresses = data.map(b => b.tokenAddress).filter(Boolean);
    } else if (data && Array.isArray(data.boosts)) {
      addresses = data.boosts.map(b => b.tokenAddress).filter(Boolean);
    }

    if (addresses.length > 0) {
      log(`[CryptoAPI] DexScreener: ${addresses.length} boosted token addresses.`);
      return addresses;
    }
    log("[WARN] [CryptoAPI] DexScreener returned no addresses or unexpected format.");
    return [];
  } catch (error) {
    log(`[ERR] [CryptoAPI] DexScreener error: ${(error as Error).message}`);
    return [];
  }
}
