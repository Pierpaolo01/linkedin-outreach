/**
 * The check behind the Settings "Test" button (spec section 8): one tiny name cleaning and one card
 * scoring on invented people, timed. Nothing here touches LinkedIn.
 */
import type { Ai, Answer, CardForScoring, CardScore, CleanedVariables } from "./types";

export const SELF_TEST_NAME = { fullName: "Dott. Marco Rossi 🚀 | Growth", company: "ROSSI COSTRUZIONI S.R.L." } as const;

export const SELF_TEST_BRIEF = "Owners of small building and renovation firms in northern Italy.";

/** Invented people; any likeness to a real profile is chance. */
export const SELF_TEST_CARDS: readonly CardForScoring[] = [
  {
    publicId: "test-anna-verdi",
    fullName: "Anna Verdi",
    headline: "Titolare at Verdi Ristrutturazioni | Renovating homes since 2004",
    location: "Bergamo, Lombardy, Italy",
    company: "Verdi Ristrutturazioni",
  },
  {
    publicId: "test-luca-neri",
    fullName: "Luca Neri",
    headline: "Senior Software Engineer",
    location: "Berlin, Germany",
    company: "Example Cloud GmbH",
  },
];

export interface SelfTestResult {
  readonly cleaned: Answer<CleanedVariables>;
  readonly scored: Answer<readonly CardScore[]>;
  readonly cleanMs: number;
  readonly scoreMs: number;
}

export async function runAiSelfTest(ai: Ai, now: () => number = () => performance.now()): Promise<SelfTestResult> {
  const cleanStart = now();
  const cleaned = await ai.cleanVariables(SELF_TEST_NAME);
  const cleanMs = now() - cleanStart;
  const scoreStart = now();
  const scored = await ai.scoreCards(SELF_TEST_BRIEF, SELF_TEST_CARDS);
  const scoreMs = now() - scoreStart;
  return { cleaned, scored, cleanMs, scoreMs };
}
