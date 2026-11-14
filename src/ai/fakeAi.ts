/**
 * A deterministic AI for tests and the engine simulation. It never calls anything.
 *
 * Scoring: every word of 4+ letters in the brief (a few filler words aside) that appears as a whole
 * word in the person's text is worth 3 points, capped at 10. A card with some but not a full match
 * asks for its profile to be opened. Names and companies are cleaned by simple rules, and the
 * personalised line quotes the first sentence of the about text.
 */
import type { Ai, CardScore, CleanedVariables, ProfileForScoring } from "./types";

const MODEL = "fake";
const FILLER = new Set(["with", "from", "that", "this", "have", "they", "them", "their", "about", "which", "what", "when", "where", "into", "over", "under", "around", "more", "less", "than", "only", "some", "people", "anyone", "should"]);

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function keywords(brief: string): string[] {
  return [...new Set(words(brief).filter((word) => word.length >= 4 && !FILLER.has(word)))];
}

function judge(brief: string, parts: readonly (string | null)[]): { score: number; reason: string } {
  const present = new Set(words(parts.filter((part) => part !== null).join(" ")));
  const matched = keywords(brief).filter((word) => present.has(word));
  return {
    score: Math.min(10, matched.length * 3),
    reason: matched.length === 0 ? "Nothing on the card matches the brief." : `Matches the brief on: ${matched.join(", ")}.`,
  };
}

function profileParts(profile: ProfileForScoring): (string | null)[] {
  const parts = [profile.headline, profile.location, profile.about, profile.currentTitle, profile.currentCompany];
  for (const job of profile.experience) parts.push(job.title, job.company, job.description);
  return parts;
}

const TITLES = new Set(["dott", "dottssa", "dottor", "dottore", "dr", "ing", "avv", "arch", "geom", "prof", "rag", "sig", "sigra", "mr", "mrs", "ms"]);
const LEGAL_FORM = /[\s,]+(s\.?\s?r\.?\s?l\.?s?|s\.?\s?p\.?\s?a\.?|s\.?\s?n\.?\s?c\.?|s\.?\s?a\.?\s?s\.?|ltd\.?|gmbh|inc\.?|llc)\s*$/i;

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function firstName(fullName: string): string | null {
  const beforeTagline = fullName.split(/[|•·,(–—]/)[0] ?? "";
  const tokens = beforeTagline
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}'’-]/gu, ""))
    .filter((token) => token !== "" && !TITLES.has(token.toLowerCase().replace(/['’-]/g, "")));
  const first = tokens[0];
  return first === undefined ? null : capitalise(first);
}

function companyShort(company: string | null): string | null {
  if (company === null) return null;
  const bare = (company.split(/[|•·]/)[0] ?? "").replace(LEGAL_FORM, "").replace(/[\s,.-]+$/, "").trim();
  if (bare === "") return null;
  return bare === bare.toUpperCase() ? bare.split(/\s+/).map(capitalise).join(" ") : bare;
}

export function createFakeAi(): Ai {
  return {
    async scoreCards(brief, cards) {
      const value = cards.map((card): CardScore => {
        const { score, reason } = judge(brief, [card.headline, card.location, card.company]);
        return { publicId: card.publicId, score, reason, openProfile: score > 0 && score < 9 };
      });
      return { value, model: MODEL };
    },

    async scoreProfile(brief, profile) {
      return { value: { ...judge(brief, profileParts(profile)), industry: null, size: null }, model: MODEL };
    },

    async cleanVariables(input) {
      const value: CleanedVariables = { firstName: firstName(input.fullName), companyShort: companyShort(input.company) };
      return { value, model: MODEL };
    },

    async personalise(input) {
      const sentence = /^[^.!?]*[.!?]/.exec(input.profile.about?.trim() ?? "")?.[0].trim();
      if (sentence === undefined || sentence.length < 20) return { value: null, model: MODEL };
      const line = `Your profile says: "${sentence}"`;
      if (line.length > (input.maxLength ?? Infinity)) return { value: null, model: MODEL };
      return { value: { line, evidence: sentence }, model: MODEL };
    },
  };
}
