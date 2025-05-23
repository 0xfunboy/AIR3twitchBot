<<<<<<< HEAD
# AIR3twitchBot-
AIR³ Twitch Crypto Bot is a TypeScript-based Twitch bot that periodically asks crypto-related questions in your channel.
=======
# AIR³ Twitch Crypto Bot

**AIR³ Twitch Crypto Bot** is a TypeScript-based Twitch bot that periodically asks crypto-related questions in your channel.  
It supports dual Twitch accounts, configurable intervals, and pulls real-time data and analysis from CoinMarketCap & CoinGecko.



## Features

- **Dual-bot support**: Run two Twitch bots concurrently (e.g. one for questions, one for replies).  
- **Configurable question schedule**: Define `DELTA_T_MIN`/`DELTA_T_MAX` (in minutes) for randomized intervals.  
- **Crypto data & analysis**:  
  - Current prices & market caps (CoinGecko, CoinMarketCap)  
  - Historical analysis & sentiment  
  - Token-specific insights  
- **Natural-language question templates**: A JSON file of English prompts with built-in “errors” and calls to `@air3_agent`.



## Getting Started

### Prerequisites

- Node.js ≥ 16  
- A Twitch application with `clientId`/`clientSecret` and a refresh token  
- API keys for CoinGecko and CoinMarketCap  

### Installation

1. **Clone the repo**  

   git clone git@github.com:<your-username>/AIR3twitchBot.git
   cd AIR3twitchBot


2. **Install dependencies**


   npm install
   # or
   pnpm install
   # or
   yarn


3. **Configure secrets**
   Copy the example config and fill in your credentials:


   cp chatbot.config.json.example chatbot.config.json
   cp .env.example .env


   * `chatbot.config.json` → Twitch client IDs, secrets, refresh tokens
   * `.env` → `CMK_API_KEY`, `CG_API_KEY`, plus:


     DELTA_T_MIN=30
     DELTA_T_MAX=90


4. **Build**


   npm run build


### Running

* **Development** (with auto-reload):


  npm run dev

* **Production**:


  npm start




## Configuration

* **`chatbot.config.json`**


  {
    "twitch": {
      "bot1": {
        "clientId": "...",
        "clientSecret": "...",
        "refreshToken": "...",
        "channelUserId": "...",
        "botUserId": ""
      },
      "bot2": { /* same shape as bot1 */ }
    }
  }

* **`.env`**

dotenv
  CMK_API_KEY=your_coinmarketcap_key
  CG_API_KEY=your_coingecko_key
  DELTA_T_MIN=20
  DELTA_T_MAX=60




## Question Templates

All your natural-language prompts live in `questions.json`. Example entry:


[
  {
    "template": "Hey @air3_agent, what’s the current market cap and price of {{token}}?",
    "type": "GET_TOKEN_PRICE"
  },
  {
    "template": "Could you give me an overview of {{coin}}’s historical performance?",
    "type": "GET_CRYPTO_ANALYSIS"
  }
]




## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Commit your changes: `git commit -m "Add your feature"`
4. Push and open a PR



## License

MIT © \ AIRewardrop
>>>>>>> 797c3a2 (Add README)
