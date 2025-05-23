import fetch, { Headers, Response as FetchResponse } from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import { log } from "./logger";

// Configuration schema for a single Twitch bot
const twitchBotConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
  oauthToken: z.string().optional(),
  channelUserId: z.string().min(1), // Channel ID where this bot will send messages
  botUserId: z.string().optional(), // Bot's own user ID, will be filled after validation
});
export type TwitchBotConfig = z.infer<typeof twitchBotConfigSchema>;

// Overall chatbot configuration structure
const chatbotConfigSchema = z.object({
  twitch: z.object({
    bot1: twitchBotConfigSchema,
    bot2: twitchBotConfigSchema,
  }),
});
type ChatbotConfig = z.infer<typeof chatbotConfigSchema>;


interface OAuthResp {
  access_token?: string;
  refresh_token?: string;
  message?: string;
  expires_in?: number;
}

interface ValidateResp {
  user_id: string;
  login: string;
  scopes: string[];
  expires_in: number;
}

const CONFIG_PATH = path.resolve(process.cwd(), "chatbot.config.json");

export class TwitchClient {
  private cfg: TwitchBotConfig;
  private token = "";
  private userId = ""; // Bot's own user ID
  private botIdentifier: string; // e.g., "bot1" or "bot2" for logging/config updates

  constructor(rawConfig: unknown, botKey: string) {
    this.cfg = twitchBotConfigSchema.parse(rawConfig);
    this.botIdentifier = botKey;
    if (this.cfg.oauthToken) {
      this.token = this.cfg.oauthToken;
    }
    if (this.cfg.botUserId) {
      this.userId = this.cfg.botUserId;
    }
  }

  /**
   * Initializes the Twitch client by ensuring a valid token and starting refresh timers.
   */
  async start(): Promise<void> {
    log(`[TwitchClient-${this.botIdentifier}] Starting...`);
    await this.ensureToken();
    this.startTokenRefreshTimer(); // Refreshes token well before expiry
    this.startTokenValidationTimer(); // Periodically validates token
    log(`[TwitchClient-${this.botIdentifier}] Started successfully for bot ID ${this.userId} targeting channel ${this.cfg.channelUserId}.`);
  }

  /**
   * Ensures a valid token is available, refreshing if necessary.
   */
  private async ensureToken(): Promise<void> {
    if (!this.token) {
      log(`[TwitchClient-${this.botIdentifier}] No OAuth token found. Attempting refresh...`);
      await this.refreshToken();
    }
    await this.validateToken(); // Sets this.userId and persists if needed
  }

  /**
   * Refreshes the OAuth token using the refresh token.
   */
  private async refreshToken(): Promise<void> {
    log(`[TwitchClient-${this.botIdentifier}] Refreshing token...`);
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      grant_type: "refresh_token",
      refresh_token: this.cfg.refreshToken,
    });

    try {
      const r: FetchResponse = await fetch("https://id.twitch.tv/oauth2/token", {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/x-www-form-urlencoded" }),
        body,
      });

      const j = (await r.json()) as OAuthResp;

      if (!r.ok || !j.access_token) {
        throw new Error(
          `Token refresh failed (status ${r.status}): ${j.message || JSON.stringify(j)}`
        );
      }

      this.token = j.access_token;
      if (j.refresh_token) { // Twitch may return a new refresh token
        this.cfg.refreshToken = j.refresh_token;
      }
      log(`[TwitchClient-${this.botIdentifier}] Token refreshed successfully.`);
      await this.persistTokens();
    } catch (error) {
      log(`[ERR] [TwitchClient-${this.botIdentifier}] Token refresh error: ${(error as Error).message}`);
      throw error; // Propagate error to allow for retry logic or shutdown
    }
  }

  /**
   * Validates the current OAuth token and updates botUserId.
   */
  private async validateToken(): Promise<void> {
    log(`[TwitchClient-${this.botIdentifier}] Validating token...`);
    if (!this.token) {
        log(`[WARN] [TwitchClient-${this.botIdentifier}] No token to validate. Attempting refresh first.`);
        await this.refreshToken(); // This will throw if it fails
    }

    try {
      const r: FetchResponse = await fetch("https://id.twitch.tv/oauth2/validate", {
        headers: { Authorization: `OAuth ${this.token}` },
      });

      if (!r.ok) {
        const errorText = await r.text();
        log(`[ERR] [TwitchClient-${this.botIdentifier}] Token validation failed (status ${r.status}): ${errorText}. Attempting refresh.`);
        // If validation fails, token is likely expired or invalid
        await this.refreshToken(); // Try to get a new token
        // Re-validate after refresh
        const r2 = await fetch("https://id.twitch.tv/oauth2/validate", {
            headers: { Authorization: `OAuth ${this.token}` }
        });
        if (!r2.ok) {
            throw new Error(`Token still invalid after refresh: ${await r2.text()}`);
        }
        const data2 = (await r2.json()) as ValidateResp;
        this.userId = data2.user_id;
      } else {
        const data = (await r.json()) as ValidateResp;
        this.userId = data.user_id;
      }
      
      log(`[TwitchClient-${this.botIdentifier}] Token validated for user ID: ${this.userId}.`);

      if (this.cfg.botUserId !== this.userId) {
        this.cfg.botUserId = this.userId;
        await this.persistTokens();
      }
    } catch (error) {
      log(`[ERR] [TwitchClient-${this.botIdentifier}] Token validation/refresh error: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Persists the current tokens (oauthToken, refreshToken, botUserId) back to chatbot.config.json.
   */
  private async persistTokens(): Promise<void> {
    try {
      const raw = await fs.readFile(CONFIG_PATH, "utf8");
      const cfgDisk = JSON.parse(raw) as ChatbotConfig;

      // Find the correct bot config (bot1 or bot2) to update
      const botKey = this.botIdentifier as keyof ChatbotConfig["twitch"];
      if (cfgDisk.twitch[botKey] && cfgDisk.twitch[botKey].clientId === this.cfg.clientId) {
        cfgDisk.twitch[botKey].refreshToken = this.cfg.refreshToken;
        cfgDisk.twitch[botKey].oauthToken = this.token;
        cfgDisk.twitch[botKey].botUserId = this.userId;
      }

      await fs.writeFile(CONFIG_PATH, JSON.stringify(cfgDisk, null, 2));
      log(`[TwitchClient-${this.botIdentifier}] Tokens persisted to ${CONFIG_PATH}.`);
    } catch (error) {
      log(`[WARN] [TwitchClient-${this.botIdentifier}] Failed to persist tokens: ${(error as Error).message}`);
    }
  }

  /**
   * Sends a chat message to the configured Twitch channel.
   * @param text - The message text to send.
   */
  async sendMessage(text: string): Promise<void> {
    if (!this.userId) {
      log(`[WARN] [TwitchClient-${this.botIdentifier}] Bot User ID not set. Validating token first.`);
      await this.validateToken(); // Ensure userId is set
      if(!this.userId) {
        log(`[ERR] [TwitchClient-${this.botIdentifier}] Cannot send message: Bot User ID still not set after validation.`);
        return;
      }
    }

    const url = "https://api.twitch.tv/helix/chat/messages";
    const body = {
      broadcaster_id: this.cfg.channelUserId, // ID of the channel to send the message to
      sender_id: this.userId, // ID of the user sending the message (the bot itself)
      message: text,
    };

    try {
      const r: FetchResponse = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Client-Id": this.cfg.clientId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!r.ok) {
        const errorData = await r.text();
        log(
          `[ERR] [TwitchClient-${this.botIdentifier}] sendMessage failed to channel ${this.cfg.channelUserId} (status ${r.status}): ${errorData}`
        );
      } else {
        log(`[TwitchClient-${this.botIdentifier}] Message sent to channel ${this.cfg.channelUserId}: "${text}"`);
      }
    } catch (error) {
      log(`[ERR] [TwitchClient-${this.botIdentifier}] sendMessage error: ${(error as Error).message}`);
    }
  }

  /**
   * Starts a timer to periodically refresh the token (e.g., every 3 hours).
   * Twitch tokens typically last around 4 hours.
   */
  private startTokenRefreshTimer() {
    const refreshInterval = 3 * 60 * 60 * 1000; // 3 hours
    setInterval(() => {
      this.refreshToken().catch(e =>
        log(`[ERR] [TwitchClient-${this.botIdentifier}] Scheduled token refresh failed: ${(e as Error).message}`)
      );
    }, refreshInterval);
    log(`[TwitchClient-${this.botIdentifier}] Token auto-refresh scheduled every ${refreshInterval / (60*1000)} minutes.`);
  }

  /**
   * Starts a timer to periodically validate the token (e.g., every 30 minutes).
   * This helps detect token issues sooner than just waiting for refresh.
   */
  private startTokenValidationTimer() {
    const validationInterval = 30 * 60 * 1000; // 30 minutes
    setInterval(() => {
      this.validateToken().catch(async e => {
        log(`[WARN] [TwitchClient-${this.botIdentifier}] Scheduled token validation failed: ${(e as Error).message}. Attempting immediate refresh.`);
        // If validation fails, try to refresh immediately as the token might be compromised/expired
        try {
            await this.refreshToken();
            await this.validateToken(); // Re-validate after refresh
        } catch (refreshError) {
            log(`[ERR] [TwitchClient-${this.botIdentifier}] Immediate refresh after validation failure also failed: ${(refreshError as Error).message}`);
        }
      });
    }, validationInterval);
     log(`[TwitchClient-${this.botIdentifier}] Token auto-validation scheduled every ${validationInterval / (60*1000)} minutes.`);
  }
}