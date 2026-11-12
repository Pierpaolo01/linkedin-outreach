/**
 * The four AI tasks of spec section 8, on top of any `AiProvider`. Each builds its prompt, asks for
 * JSON only, validates the answer with zod and, on an invalid answer, asks once more with the
 * validation error appended. A second invalid answer is `AiUnavailable`.
 */
import { z } from "zod";
import {
  CLEAN_VARIABLES_SYSTEM,
  PERSONALISE_SYSTEM,
  SCORE_CARDS_SYSTEM,
  SCORE_PROFILE_SYSTEM,
  cleanVariablesPrompt,
  personalisePrompt,
  retryPrompt,
  scoreCardsPrompt,
  scoreProfilePrompt,
} from "./prompts";
import { jsonSchemaFor, type AiProvider } from "./provider";
import { AiUnavailable, type Ai, type Answer, type CardForScoring, type ProfileForScoring } from "./types";

const score = z.number().int().min(0).max(10);
const reason = z.string().trim().min(1);

const cardScoresSchema = z.object({
  scores: z.array(z.object({ publicId: z.string(), score, reason, openProfile: z.boolean() })),
});

const evidenceSchema = z
  .object({ value: z.string().trim().min(1), source: z.string().trim().min(1), confidence: z.number().min(0).max(1) })
  .nullable();

const profileScoreSchema = z.object({ score, reason, industry: evidenceSchema, size: evidenceSchema });

const cleanedSchema = z.object({
  firstName: z.string().trim().min(1).nullable(),
  companyShort: z.string().trim().min(1).nullable(),
});

const MAX_LINE = 280;
const personalisedSchema = z.object({
  line: z.string().trim().min(1).max(MAX_LINE).nullable(),
  evidence: z.string().trim().min(1).nullable(),
});

/**
 * A path segment safe to show the model: an array index, or a plain field name (ours, since every
 * object schema here is fixed). Anything else could be a key the model invented, so it is masked.
 */
function safeSegment(segment: PropertyKey): string {
  if (typeof segment === "number") return String(segment);
  return typeof segment === "string" && /^[A-Za-z]{1,32}$/.test(segment) ? segment : "?";
}

/** One fixed sentence per issue code. `issue.message` is never used: zod may quote received values in it. */
function issueSentence(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return "is missing or has the wrong type";
    case "too_big":
      return `is too large or too long (at most ${String(issue.maximum)})`;
    case "too_small":
      return `is too small or too short (at least ${String(issue.minimum)})`;
    default:
      return "is not valid";
  }
}

/**
 * Most of a validation error, kept short enough to append to a prompt. Built only from fixed
 * sentences, field names and limits from our schema, so nothing the model wrote is echoed back.
 */
function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.map(safeSegment).join(".") : "answer"} ${issueSentence(issue)}`)
    .join("; ");
}

function stripFence(text: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text.trim());
  return fenced?.[1] ?? text.trim();
}

type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

function check<T>(text: string, schema: z.ZodType<T>, extra: (value: T) => string | null): Checked<T> {
  let json: unknown;
  try {
    json = JSON.parse(stripFence(text));
  } catch {
    return { ok: false, error: "it was not valid JSON" };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, error: describe(parsed.error) };
  const problem = extra(parsed.data);
  return problem === null ? { ok: true, value: parsed.data } : { ok: false, error: problem };
}

async function ask<T>(
  provider: AiProvider,
  task: {
    readonly name: string;
    readonly system: string;
    readonly prompt: string;
    readonly schema: z.ZodType<T>;
    readonly extra?: (value: T) => string | null;
  },
): Promise<Answer<T>> {
  const schema = jsonSchemaFor(task.schema);
  const extra = task.extra ?? (() => null);
  let prompt = task.prompt;
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    let completion;
    try {
      completion = await provider.complete({ system: task.system, prompt, schema });
    } catch (error) {
      if (error instanceof AiUnavailable) throw error;
      throw new AiUnavailable(`The AI could not be reached for ${task.name}.`, { cause: error });
    }
    const checked = check(completion.text, task.schema, extra);
    if (checked.ok) return { value: checked.value, model: completion.model };
    lastError = checked.error;
    prompt = retryPrompt(task.prompt, lastError);
  }
  throw new AiUnavailable(`The AI answered ${task.name} in the wrong shape twice (${lastError}).`);
}

/**
 * Every card scored exactly once. Problems are told by position (entry N of the answer, card N of
 * the data sent), never by id: ids in the answer are the model's text and ids sent are LinkedIn's.
 */
function sameCards(cards: readonly CardForScoring[]) {
  return (value: z.infer<typeof cardScoresSchema>): string | null => {
    const expected = new Set(cards.map((card) => card.publicId));
    const seen = new Set<string>();
    for (const [index, entry] of value.scores.entries()) {
      const where = `scores entry ${index + 1}`;
      if (!expected.has(entry.publicId)) return `${where} has a publicId that is not one of the cards given`;
      if (seen.has(entry.publicId)) return `${where} repeats a publicId already scored`;
      seen.add(entry.publicId);
    }
    const missing = cards.flatMap((card, index) => (seen.has(card.publicId) ? [] : [index + 1]));
    if (missing.length === 0) return null;
    return `no score for card ${missing.join(", card ")} of the ${cards.length} in the LinkedIn data`;
  };
}

/** Lower case, one kind of quote and dash, single spaces: how evidence is compared with the profile. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function profileText(profile: ProfileForScoring): string {
  const parts = [profile.fullName, profile.headline, profile.location, profile.about, profile.currentTitle, profile.currentCompany];
  for (const job of profile.experience) parts.push(job.title, job.company, job.dateRange, job.description);
  return normalise(parts.filter((part): part is string => part !== null).join("\n"));
}

/** Shorter evidence (after normalising), or evidence with no letter, supports no line: "" is in every profile. */
const MIN_EVIDENCE = 12;

function quotedFrom(profile: ProfileForScoring) {
  const text = profileText(profile);
  return (value: z.infer<typeof personalisedSchema>): string | null => {
    if (value.line === null && value.evidence === null) return null;
    if (value.line === null || value.evidence === null) return "line and evidence must both be text or both be null";
    const quoted = normalise(value.evidence.replace(/^["'“‘]+|["'”’]+$/g, ""));
    if (quoted.length < MIN_EVIDENCE || !/\p{L}/u.test(quoted)) {
      return `evidence must quote at least ${MIN_EVIDENCE} characters of profile text, including words`;
    }
    return text.includes(quoted) ? null : "evidence must be copied word for word from the profile";
  };
}

export function aiFromProvider(provider: AiProvider): Ai {
  return {
    async scoreCards(brief, cards) {
      if (cards.length === 0) return { value: [], model: "none" };
      const answer = await ask(provider, {
        name: "card scoring",
        system: SCORE_CARDS_SYSTEM,
        prompt: scoreCardsPrompt(brief, cards),
        schema: cardScoresSchema,
        extra: sameCards(cards),
      });
      return { value: answer.value.scores, model: answer.model };
    },

    scoreProfile(brief, profile) {
      return ask(provider, {
        name: "profile scoring",
        system: SCORE_PROFILE_SYSTEM,
        prompt: scoreProfilePrompt(brief, profile),
        schema: profileScoreSchema,
      });
    },

    async cleanVariables(input) {
      const answer = await ask(provider, {
        name: "name cleaning",
        system: CLEAN_VARIABLES_SYSTEM,
        prompt: cleanVariablesPrompt(input),
        schema: cleanedSchema,
      });
      const hasCompany = input.company !== null && input.company.trim() !== "";
      return { value: { ...answer.value, companyShort: hasCompany ? answer.value.companyShort : null }, model: answer.model };
    },

    async personalise(input) {
      const answer = await ask(provider, {
        name: "personalisation",
        system: PERSONALISE_SYSTEM,
        prompt: personalisePrompt(input),
        schema: personalisedSchema,
        extra: quotedFrom(input.profile),
      });
      const { line, evidence } = answer.value;
      return { value: line === null || evidence === null ? null : { line, evidence }, model: answer.model };
    },
  };
}
