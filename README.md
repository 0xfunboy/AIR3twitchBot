# AIR3 Twitch Crypto Bot

A TypeScript Twitch bot that keeps a channel alive by asking timely, natural-sounding crypto questions — always tagging the AI agent bot (`AGENT_NAME`) so the agent's actions (price lookups, charts, analysis, holder scans, token info) get triggered in chat.

## Features

- **Dual-bot support** — two Twitch bot accounts alternate round-robin, so the chat doesn't look like one account spamming.
- **Agent action triggers** — every question tags the configured agent handle and contains the action keywords the agent reacts to (`price`, `chart`, `analyze`, `holders`, `info`, ...). A safety net guarantees the tag is always present.
- **Three rotating token sources**:
  1. **CoinGecko trending** — what people are actually searching right now
  2. **CoinMarketCap top listings** — majors with 24h change data
  3. **DexScreener top boosts** — fresh contract addresses (no key needed)
- **Sentiment-aware questions** — when a token moved ±5% in 24h, the bot usually reacts to the move ("X is pumping, what's driving it?" / "X is bleeding, where's support?") instead of asking a generic question.
- **Credibility guards** — no template repeated within the last 12 questions, no token repeated within the last 6 picks, stablecoins/wrapped assets filtered out, ~1 in 6 questions is a general market question with no token.
- **API key rotation** — configure as many CoinMarketCap/CoinGecko keys as you want; requests round-robin across them and keys hitting 429/401/403 go into cooldown automatically (10 min for rate limits, 6 h for auth failures).
- **Market data caching** — source responses are cached for 10 minutes so questions don't burn API credits.
- **Token auto-refresh** — Twitch OAuth tokens are refreshed every 3 h, validated every 30 min, and persisted back to `chatbot.config.json`.

## Requirements

- Node.js ≥ 18
- A Twitch application (clientId/clientSecret) and **two** Twitch bot accounts, each authorized with scope `user:write:chat`
- At least one CoinMarketCap API key (free Basic plan works); CoinGecko demo keys optional but recommended

## Setup

### 1. Install

```bash
git clone <repo-url> && cd AIR3twitchBot
pnpm install   # or npm install
```

### 2. Configure secrets

Both files are gitignored.

**`.env`** (copy from `.env.example`):

```dotenv
# CoinMarketCap keys — add KEY2..KEYN for rotation
COINMARKETCAP_KEY=...
COINMARKETCAP_KEY2=...

# CoinGecko demo keys ("CG-...") — add KEY2..KEYN for rotation
COINGECKO_KEY=CG-...
COINGECKO_KEY2=CG-...

# Random wait between questions, in minutes (MAX must be > MIN)
DELTA_T_MIN_MINUTES=20
DELTA_T_MAX_MINUTES=60

# The agent bot every question tags
AGENT_NAME=@your_agent_handle
```

**`chatbot.config.json`**:

```json
{
  "twitch": {
    "bot1": {
      "clientId": "...",
      "clientSecret": "...",
      "refreshToken": "...",
      "channelUserId": "...",
      "botUserId": ""
    },
    "bot2": { "same shape as bot1, different account": "" }
  }
}
```

- `clientId`/`clientSecret`: from your app at https://dev.twitch.tv/console/apps (one app can serve both bots).
- `refreshToken`: authorize each bot account with scope `user:write:chat`, e.g. with the Twitch CLI: `twitch token -u -s user:write:chat` (log in as the bot account; repeat for the second account). Refresh tokens are bound to the clientId that issued them.
- `channelUserId`: numeric user ID of the channel to post in (`twitch api get /users -q login=channel_name`).
- `botUserId`: leave empty — filled in automatically on first token validation. Keep the file writable: the bot persists rotated tokens back into it.

The bot exits at startup if both bots resolve to the same Twitch userId — they must be two distinct accounts.

### 3. Run

```bash
pnpm build && pnpm start   # production
pnpm dev                   # development (ts-node)
```

## How a question is produced

1. Wait a random `DELTA_T_MIN..MAX` minutes.
2. Pick the next source in the cycle (CoinGecko → CoinMarketCap → DexScreener), falling back to the others if it yields nothing; skip tokens asked recently. ~1 in 6 iterations skips the token and asks a general market question.
3. Pick a template from `questions.json`: if the token moved ±5% in 24h there's a 60% chance of a mover-specific template (`MOVER_UP`/`MOVER_DOWN`); recently used templates are excluded.
4. Substitute `[AGENT_NAME]` and `[TOKEN_IDENTIFIER]` (tickers get a `$` prefix; DexScreener contributes raw contract addresses).
5. Send with the next bot in the round-robin.

## Question templates

Templates live in `questions.json`, grouped by category. Placeholders:

- `[AGENT_NAME]` — replaced with the configured agent handle (required — a tag is force-prepended if missing)
- `[TOKEN_IDENTIFIER]` — replaced with `$TICKER` or a contract address; categories whose templates contain it are only used when a token is available

Categories: `GENERAL` and `MAJORS` (no token), `TOKEN_PRICE`, `TOKEN_CHART`, `TOKEN_ANALYSIS`, `TOKEN_HOLDERS`, `TOKEN_FUNDAMENTAL` (token), and `MOVER_UP`/`MOVER_DOWN` (only used on strong 24h moves). Keep the agent's trigger keywords (price / chart / analyze / holders / info) in any template you add, or the agent won't fire its action.

## Files written at runtime

| File | Purpose |
|---|---|
| `chatbot.config.json` | updated with rotated refresh/OAuth tokens and bot user IDs |
| `discovered_dex_tokens.json` | persisted DexScreener address store (max 200) |
| `bot.log` | append-only log |

## License

MIT © AIRewardrop
