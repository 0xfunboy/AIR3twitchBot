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
  // Categories that require a token identifier (either ticker or address)
  private categoriesRequiringToken: string[]; 

  constructor() {
    this.categoriesRequiringToken = [
        "GET_CRYPTO_ANALYSIS",
        "GET_CRYPTO_PRICE",
        "GET_TOKEN_ANALYSIS",
        "GET_TOKEN_PRICE",
        "GET_NEWS"
    ];
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

    let randomCategory = this.categories[Math.floor(Math.random() * this.categories.length)];
    
    // If tokenInfo is provided, try to pick a category that uses tokens.
    // If not, or if it randomly picks one anyway, it will proceed.
    // If tokenInfo is NOT provided, ensure we pick a category that DOESN'T require a token.
    if (tokenInfo && !this.categoriesRequiringToken.includes(randomCategory)) {
        // If we have a token but picked a general category, try to pick a token category
        const tokenCategories = this.categories.filter(cat => this.categoriesRequiringToken.includes(cat));
        if (tokenCategories.length > 0) {
            randomCategory = tokenCategories[Math.floor(Math.random() * tokenCategories.length)];
        }
        // If still no suitable category, it might ask a general q with a token (which will be ignored by template)
    } else if (!tokenInfo) {
        // If we DON'T have a token, pick a category that doesn't need one
        const generalCategories = this.categories.filter(cat => !this.categoriesRequiringToken.includes(cat));
        if (generalCategories.length > 0) {
            randomCategory = generalCategories[Math.floor(Math.random() * generalCategories.length)];
        } else {
            // All categories require a token, but we don't have one. This is a config issue.
            log("[WARN] [QuestionService] No token provided, but all question categories require one. Check questions.json.");
            return null;
        }
    }


    const questionsInCategory = this.questions[randomCategory];

    if (!questionsInCategory || questionsInCategory.length === 0) {
      log(`[WARN] [QuestionService] No questions found in category: ${randomCategory}`);
      return null;
    }

    let questionTemplate = questionsInCategory[Math.floor(Math.random() * questionsInCategory.length)];

    // Replace [AGENT_NAME] - only relevant for categories that use it (GENERAL_AGENT_QUERIES)
    questionTemplate = questionTemplate.replace(/\[AGENT_NAME\]/g, AGENT_NAME);

    // Replace [TOKEN_IDENTIFIER] if tokenInfo is provided and category is appropriate
    if (tokenInfo && this.categoriesRequiringToken.includes(randomCategory)) {
      const displayIdentifier = tokenInfo.type === "ticker" ? `$${tokenInfo.identifier.toUpperCase()}` : tokenInfo.identifier;
      questionTemplate = questionTemplate.replace(/\[TOKEN_IDENTIFIER\]/g, displayIdentifier);
    } else {
      // If category expected a token but none was given, or vice-versa, clean up any remaining placeholder
      questionTemplate = questionTemplate.replace(/\[TOKEN_IDENTIFIER\]/g, "some hot coin"); // Fallback
    }
    
    log(`[QuestionService] Selected question: "${questionTemplate}" from category "${randomCategory}"`);
    return questionTemplate;
  }
}