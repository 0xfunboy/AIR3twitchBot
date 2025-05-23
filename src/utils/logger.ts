import fs from "fs";
import path from "path";

const LOG_FILE = path.resolve(process.cwd(), "bot.log");

export const log = (msg: string): void => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (error) {
    console.error(`[FATAL] Failed to write to log file ${LOG_FILE}:`, error);
  }
};

export const initLogger = (): void => {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(LOG_FILE, `[${new Date().toISOString()}] Log initialized.\n`);
      console.log(`Log file created at ${LOG_FILE}`);
    }
  } catch (error) {
     console.error(`[FATAL] Failed to initialize log file ${LOG_FILE}:`, error);
  }
};