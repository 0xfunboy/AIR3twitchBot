import fs from "fs/promises";
import path from "path";
import { log } from "../utils/logger";

interface QuestionSet {
  [category: string]: string[];
}

const QUESTIONS_FILE_PATH = path.resolve(process.cwd(), "questions.json");

// Categories only used when the token has a strong 24h move
const MOVER_UP_CATEGORY = "MOVER_UP";
const MOVER_DOWN_CATEGORY = "MOVER_DOWN";
const MOVER_THRESHOLD_PCT = 5;
const MOVER_PICK_PROBABILITY = 0.6;

// How many recently used templates to remember to avoid repeating ourselves
const RECENT_TEMPLATE_MEMORY = 12;

export type TokenIdentifierType = "ticker" | "address";

export interface QuestionTokenInfo {
  identifier: string;
  type: TokenIdentifierType;
  change24h?: number;
}

export class QuestionService {
  private questions: QuestionSet = {};
  private categories: string[] = [];
  private recentTemplates: string[] = [];

  async loadQuestions(): Promise<void> {
    try {
      log("[QuestionService] Loading questions...");
      const data = await fs.readFile(QUESTIONS_FILE_PATH, "utf8");
      this.questions = JSON.parse(data);
      this.categories = Object.keys(this.questions);
      if (this.categories.length === 0) {
        log("[WARN] [QuestionService] No question categories found in questions.json.");
      } else {
        const total = this.categories.reduce((n, c) => n + (this.questions[c]?.length || 0), 0);
        log(`[QuestionService] Loaded ${total} templates across ${this.categories.length} categories.`);
      }
    } catch (error) {
      log(`[ERR] [QuestionService] Failed to load questions: ${(error as Error).message}`);
      this.questions = {};
      this.categories = [];
    }
  }

  /**
   * Builds a chat-ready question. Guarantees the agent handle is present so
   * the reply bot always gets tagged, and keeps the action keywords (price,
   * chart, analyze, holders, info...) that trigger the agent's actions.
   */
  async getFormattedQuestion(tokenInfo?: QuestionTokenInfo): Promise<string | null> {
    if (this.categories.length === 0) {
      log("[WARN] [QuestionService] No questions loaded to choose from.");
      return null;
    }

    const agentTag = process.env.AGENT_NAME || "@bot_agent";
    const needsToken = (tpl: string) => tpl.includes("[TOKEN_IDENTIFIER]");
    const isMoverCategory = (cat: string) => cat === MOVER_UP_CATEGORY || cat === MOVER_DOWN_CATEGORY;

    // Sentiment-aware category pick: when the token made a strong 24h move,
    // usually react to it — that's what a real chatter would comment on.
    let forcedCategory: string | null = null;
    if (tokenInfo?.change24h !== undefined && Math.random() < MOVER_PICK_PROBABILITY) {
      if (tokenInfo.change24h >= MOVER_THRESHOLD_PCT && this.questions[MOVER_UP_CATEGORY]?.length) {
        forcedCategory = MOVER_UP_CATEGORY;
      } else if (tokenInfo.change24h <= -MOVER_THRESHOLD_PCT && this.questions[MOVER_DOWN_CATEGORY]?.length) {
        forcedCategory = MOVER_DOWN_CATEGORY;
      }
    }

    const usableTemplates = (cat: string): string[] => {
      const templates = this.questions[cat] || [];
      return tokenInfo
        ? templates.filter(needsToken)
        : templates.filter(t => !needsToken(t));
    };

    let pool: string[] = [];
    if (forcedCategory) {
      pool = usableTemplates(forcedCategory);
    }
    if (pool.length === 0) {
      const candidateCategories = this.categories.filter(
        cat => !isMoverCategory(cat) && usableTemplates(cat).length > 0
      );
      if (candidateCategories.length === 0) {
        log("[WARN] [QuestionService] No category fits the current context.");
        return null;
      }
      const category = candidateCategories[Math.floor(Math.random() * candidateCategories.length)];
      pool = usableTemplates(category);
    }

    // Avoid repeating a template we used recently; fall back if we'd empty the pool.
    const fresh = pool.filter(t => !this.recentTemplates.includes(t));
    const finalPool = fresh.length > 0 ? fresh : pool;
    const template = finalPool[Math.floor(Math.random() * finalPool.length)];

    this.recentTemplates.push(template);
    if (this.recentTemplates.length > RECENT_TEMPLATE_MEMORY) {
      this.recentTemplates.shift();
    }

    let question = template
      .replace(/\[AGENT_NAME\]/g, agentTag)
      .replace(/@AIR3_Agent|@AIRewardrop/g, agentTag); // legacy hardcoded tags

    if (needsToken(question) && tokenInfo) {
      const display =
        tokenInfo.type === "ticker"
          ? `$${tokenInfo.identifier.toUpperCase()}`
          : tokenInfo.identifier;
      question = question.replace(/\[TOKEN_IDENTIFIER\]/g, display);
    }

    // Safety net: the whole point is triggering the agent, so never send a
    // message without its tag.
    if (!question.toLowerCase().includes(agentTag.toLowerCase())) {
      question = `${agentTag} ${question}`;
    }

    log(`[QuestionService] Selected question: "${question}"`);
    return question;
  }
}
