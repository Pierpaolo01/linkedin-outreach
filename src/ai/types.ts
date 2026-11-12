/**
 * What the app asks of an AI (spec section 8). The engine depends on this file
 * only; providers (the `claude` CLI, the Anthropic API, the fake used in tests)
 * live beside it. The AI scores and tidies text. It never decides whether
 * something is sent: that is always the engine and the limits.
 */
import type { Evidence } from "../db/schema";

/** A person as a list shows them, before their profile is opened. */
export interface CardForScoring {
  readonly publicId: string;
  readonly fullName: string;
  readonly headline: string | null;
  readonly location: string | null;
  readonly company: string | null;
}

export interface CardScore {
  readonly publicId: string;
  /** 0 (does not fit the scoring brief) to 10 (fits it exactly). */
  readonly score: number;
  /** One or two sentences the user reads in the approval queue. */
  readonly reason: string;
  /** The card alone is not enough to decide and the profile is worth opening. */
  readonly openProfile: boolean;
}

export interface ProfileForScoring {
  readonly publicId: string;
  readonly fullName: string;
  readonly headline: string | null;
  readonly location: string | null;
  readonly about: string | null;
  readonly currentTitle: string | null;
  readonly currentCompany: string | null;
  readonly experience: readonly {
    readonly title: string;
    readonly company: string | null;
    readonly dateRange: string | null;
    readonly description: string | null;
  }[];
}

export interface ProfileScore {
  readonly score: number;
  readonly reason: string;
  /** What the profile supports about the business, with where it was read. Null when the profile does not say. */
  readonly industry: Evidence | null;
  readonly size: Evidence | null;
}

export interface CleanedVariables {
  /** "Dott. Marco Rossi 🚀 | Growth" → "Marco". Null when no first name can be told with confidence. */
  readonly firstName: string | null;
  /** "ROSSI COSTRUZIONI S.R.L." → "Rossi Costruzioni". Null when there is no company. */
  readonly companyShort: string | null;
}

export interface PersonalisedLine {
  /** One sentence for `{{ai_line}}`, using only facts in `evidence`. */
  readonly line: string;
  /** The profile text the line rests on, quoted. */
  readonly evidence: string;
}

/** Every answer says which model gave it, for the `score_model` column and the activity log. */
export interface Answer<T> {
  readonly value: T;
  readonly model: string;
}

export interface Ai {
  /** Scores up to about ten cards in one call. Returns one score per card given, in any order. */
  scoreCards(brief: string, cards: readonly CardForScoring[]): Promise<Answer<readonly CardScore[]>>;
  scoreProfile(brief: string, profile: ProfileForScoring): Promise<Answer<ProfileScore>>;
  cleanVariables(input: { readonly fullName: string; readonly company: string | null }): Promise<Answer<CleanedVariables>>;
  /** Null value when the profile supports no honest line; the caller then leaves `{{ai_line}}` unresolved. */
  personalise(input: {
    readonly profile: ProfileForScoring;
    readonly industry: Evidence | null;
    readonly instructions: string;
  }): Promise<Answer<PersonalisedLine | null>>;
}

/**
 * The AI could not be reached, or would not answer in the agreed shape after a
 * retry. Scoring waits and is tried again later; nothing else is blocked.
 */
export class AiUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AiUnavailable";
  }
}
