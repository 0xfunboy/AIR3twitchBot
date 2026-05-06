import fs from "fs/promises";
import path from "path";
import { log } from "../utils/logger";

interface QuestionSet {
  [category: string]: string[];
}

const QUESTIONS_FILE_PATH = path.resolve(process.cwd(), "questions.json");
const AGENT_NAME = process.env.AGENT_NAME || "@bot_agent";

export type TokenIdentifierType = "ticker" | "address";

export class QuestionService {
  private questions: QuestionSet = {};
  private categories: string[] = [];

  constructor() {

  }

  async loadQuestions(): Promise<void> {
    try {
      log("[QuestionService] Loading questions...");
      const data = await fs.readFile(QUESTIONS_FILE_PATH, "utf8");
      this.questions = JSON.parse(data);
      this.categories = Object.keys(this.questions);
      if (this.categories.length === 0) {
        log("[WARN] [QuestionService] No question categories found in questions.json.");
      } else {
        log(`[QuestionService] Loaded ${this.categories.length} question categories.`);
      }
    } catch (error) {
      log(`[ERR] [QuestionService] Failed to load questions: ${(error as Error).message}`);
      this.questions = {};
      this.categories = [];
    }
  }

  /**
   * Gets a random question, substituting placeholders as needed.
   * @param tokenInfo - Optional information about the token to use in the question.
   * @param tokenInfo.identifier - The actual token symbol or address.
   * @param tokenInfo.type - The type of the identifier ('ticker' or 'address').
   * @returns A formatted question string or null if no question can be generated.
   */
  async getFormattedQuestion(tokenInfo?: { identifier: string; type: TokenIdentifierType }): Promise<string | null> {
    if (this.categories.length === 0) {
      log("[WARN] [QuestionService] No questions loaded to choose from.");
      return null;
    }

    const needsToken = (tpl: string) => tpl.includes("[TOKEN_IDENTIFIER]");
    const agentTag = process.env.AGENT_NAME || "@bot_agent";

    // Scegli una categoria che abbia almeno un template adatto al contesto (con/ senza token)
    const categoryIsUsable = (cat: string) => {
      const tpls = this.questions[cat] || [];
      return tokenInfo ? tpls.some(needsToken) || tpls.length > 0
        : tpls.some(t => !needsToken(t));
    };

    let candidateCategories = this.categories.filter(categoryIsUsable);
    if (candidateCategories.length === 0) {
      // Fallback estremo: usa comunque tutte
      candidateCategories = this.categories.slice();
    }

    // Pick casuale tra le candidate
    let randomCategory = candidateCategories[Math.floor(Math.random() * candidateCategories.length)];
    let templates = this.questions[randomCategory] || [];

    // Costruisci il pool di template adatto
    let pool: string[] = [];
    if (tokenInfo) {
      pool = templates.filter(needsToken);
      if (pool.length === 0) pool = templates.slice(); // fallback: anche senza token
    } else {
      pool = templates.filter(t => !needsToken(t));
      if (pool.length === 0) {
        // Se proprio non ci sono template senza token in questa categoria, prova un’altra candidata
        const altCat = candidateCategories.find(cat => (this.questions[cat] || []).some(t => !needsToken(t)));
        if (altCat) {
          templates = this.questions[altCat] || [];
          pool = templates.filter(t => !needsToken(t));
        }
      }
    }

    if (pool.length === 0) {
      log(`[WARN] [QuestionService] No suitable templates in category: ${randomCategory}`);
      return null;
    }

    let questionTemplate = pool[Math.floor(Math.random() * pool.length)];

    // Sostituzione handle agente: supporta sia [AGENT_NAME] sia tag hardcoded
    questionTemplate = questionTemplate
      .replace(/\[AGENT_NAME\]/g, agentTag)
      .replace(/@AIR3_Agent|@AIRewardrop/g, agentTag);

    // Sostituzione token (solo se il template lo richiede)
    if (needsToken(questionTemplate)) {
      if (tokenInfo) {
        const display =
          tokenInfo.type === "ticker"
            ? `$${tokenInfo.identifier.toUpperCase()}`
            : tokenInfo.identifier;
        questionTemplate = questionTemplate.replace(/\[TOKEN_IDENTIFIER\]/g, display);
      } else {
        // Fallback sobrio quando manca il token
        questionTemplate = questionTemplate.replace(/\[TOKEN_IDENTIFIER\]/g, "$BTC");
      }
    }

    log(`[QuestionService] Selected question: "${questionTemplate}" from category "${randomCategory}"`);
    return questionTemplate;
  }

}