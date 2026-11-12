/**
 * Tries the configured AI once: one name cleaning and one card scoring on invented people. Prints
 * each answer, the model and the time it took. The backend of the Settings "Test" button. No LinkedIn.
 *
 *   tsx scripts/ai-test.ts
 *
 * The provider comes from the app's settings when the database exists (opened read-only), otherwise
 * from the defaults. Exit code 1 when the AI is unavailable.
 */
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createAi } from "../src/ai/index";
import { runAiSelfTest } from "../src/ai/selfTest";
import { AiUnavailable } from "../src/ai/types";
import { dataPaths } from "../src/config/paths";
import { DEFAULT_SETTINGS, getSettings, type Settings } from "../src/config/settings";
import * as schema from "../src/db/schema";

function loadAiSettings(): { readonly ai: Settings["ai"]; readonly from: string } {
  const file = dataPaths().db;
  if (!existsSync(file)) return { ai: DEFAULT_SETTINGS.ai, from: "defaults (no database yet)" };
  const sqlite = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return { ai: getSettings(drizzle(sqlite, { schema })).ai, from: file };
  } catch (error) {
    return { ai: DEFAULT_SETTINGS.ai, from: `defaults (could not read settings: ${error instanceof Error ? error.message : String(error)})` };
  } finally {
    sqlite.close();
  }
}

const { ai: aiSettings, from } = loadAiSettings();
console.log(`Provider: ${aiSettings.provider}, model: ${aiSettings.model === "" ? "(provider default)" : aiSettings.model}`);
console.log(`Settings from: ${from}`);

try {
  const result = await runAiSelfTest(createAi(aiSettings));
  console.log("\nClean variables:");
  console.log(JSON.stringify(result.cleaned.value, null, 2));
  console.log(`model ${result.cleaned.model}, ${(result.cleanMs / 1000).toFixed(1)} s`);
  console.log("\nScore cards:");
  console.log(JSON.stringify(result.scored.value, null, 2));
  console.log(`model ${result.scored.model}, ${(result.scoreMs / 1000).toFixed(1)} s`);
} catch (error) {
  if (!(error instanceof AiUnavailable)) throw error;
  console.error(`\nAI unavailable: ${error.message}`);
  process.exitCode = 1;
}
