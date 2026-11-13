/**
 * Campaign rules (spec sections 5, 9 and 17): what a wizard draft may hold, what a campaign must
 * hold before it starts, which status moves are allowed, what may change once it has started, and
 * how a template preview reads. Pure functions; the database and HTTP layers call them.
 */
import { z } from "zod";
import { DELAY_POLICIES, DISCOVERY_SOURCES, type CampaignStatus } from "../db/schema";
import { INVITE_NOTE_MAX } from "../engine/steps";
import { renderTemplate, TEMPLATE_VARIABLES, variablesIn, type RenderResult, type TemplateValues } from "../engine/template";

// ---------------------------------------------------------------- the wizard's fields

const wholeNumber = (min: number, max: number | null, message: string) => {
  const base = z.number({ error: message }).int({ error: message }).min(min, { error: message });
  return max === null ? base : base.max(max, { error: message });
};
const text = (max: number, what: string) =>
  z.string({ error: "Send text" }).max(max, { error: `Keep ${what} to ${max} characters or fewer` });
const bool = z.boolean({ error: "Send true or false" });
const threshold = wholeNumber(0, 10, "Enter a whole number from 0 to 10");
const hours = wholeNumber(0, 24 * 365, "Enter a whole number of hours, 0 or more");

/**
 * Every field the campaign wizard sets (its six steps: name; targeting; scoring brief; approval;
 * messages; timings). All optional: a draft is saved as the user goes. Unknown fields are refused.
 */
export const campaignFieldsSchema = z.strictObject({
  // 1. Name
  name: text(200, "the name"),
  // 2. Targeting
  discoverySource: z.enum(DISCOVERY_SOURCES, { error: "Choose recommendations or search" }),
  sourceUrls: z
    .array(z.string({ error: "Each address must be text" }), { error: "Send a list of addresses" })
    .max(20, { error: "Use at most 20 search addresses" }),
  targetProspectCount: wholeNumber(1, null, "Enter a whole number of 1 or more").nullable(),
  // 3. Scoring brief
  scoringBrief: text(10_000, "the scoring brief"),
  // 4. Approval
  batchSize: wholeNumber(1, null, "Enter a whole number of 1 or more"),
  autoApprove: bool,
  scoreThreshold: threshold,
  openProfileThreshold: threshold,
  // 5. Messages
  inviteNote: text(2_000, "the invite note").nullable(),
  firstMessage: text(8_000, "the first message"),
  followUp: text(8_000, "the follow-up"),
  aiPersonalise: bool,
  personalisationInstructions: text(4_000, "the personalisation instructions").nullable(),
  // 6. Timings
  acceptToMessageMinHours: hours,
  acceptToMessageMaxHours: hours,
  followUpDelayMinHours: hours,
  followUpDelayMaxHours: hours,
  delayPolicy: z.enum(DELAY_POLICIES, { error: "Choose calendar or working_days" }),
  withdrawAfterDays: wholeNumber(1, 365, "Enter a whole number of days from 1 to 365"),
}, { error: "Send a JSON object of campaign fields" }).exactPartial();

/** A change to some of a campaign's fields, as validated from a request. */
export type CampaignPatch = z.infer<typeof campaignFieldsSchema>;
/** All of a campaign's wizard fields, as stored. */
export type CampaignFields = { readonly [K in keyof CampaignPatch]-?: Exclude<CampaignPatch[K], undefined> };

/** Templates, timings and auto-approve (decision 94): the fields a campaign may still change once it has started. */
export const LIVE_EDITABLE_FIELDS = [
  "autoApprove",
  "inviteNote",
  "firstMessage",
  "followUp",
  "aiPersonalise",
  "personalisationInstructions",
  "acceptToMessageMinHours",
  "acceptToMessageMaxHours",
  "followUpDelayMinHours",
  "followUpDelayMaxHours",
  "delayPolicy",
  "withdrawAfterDays",
] as const satisfies readonly (keyof CampaignFields)[];

/** Field path → what the person should do about it. */
export type FieldProblems = Readonly<Record<string, string>>;

/** One message per field path (dotted, e.g. `sourceUrls.1`); the first issue on a path wins. */
export function fieldProblems(error: z.ZodError): FieldProblems {
  const problems: Record<string, string> = {};
  const add = (path: readonly PropertyKey[], message: string) => {
    const key = path.map(String).join(".") || "body";
    if (!(key in problems)) problems[key] = message;
  };
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) add([...issue.path, key], "Unknown field");
    } else {
      add(issue.path, issue.message);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- validation before start

const SEARCH_HOST = "www.linkedin.com";
const SEARCH_PATH = "/search/results/people/";

/**
 * An https address of a people search on www.linkedin.com: exactly what the driver's `searchPeople`
 * takes (it throws `RangeError` for anything else), so a campaign never starts with a source the
 * engine would refuse. A test runs both against the same addresses.
 */
export function isPeopleSearchUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === SEARCH_HOST && url.pathname.startsWith(SEARCH_PATH);
}

/**
 * Long but plausible values: a template that stays within a limit with these will stay within it
 * for nearly every real person. Invented.
 */
export const LONG_SAMPLE_VALUES = {
  first_name: "Maria Alessandra",
  company: "Example International Engineering and Consulting Group S.p.A.",
  title: "Head of Business Development and Strategic Partnerships",
  location: "Reggio nell'Emilia, Emilia-Romagna, Italy",
  industry: "Industrial Machinery Manufacturing",
  ai_line: "I read your recent post about bringing lean production methods to small family-owned manufacturers and found the part on suppliers useful.",
} as const satisfies Required<TemplateValues>;

const VARIABLE_LIST = `Use ${TEMPLATE_VARIABLES.slice(0, -1)
  .map((name) => `{{${name}}}`)
  .join(", ")} or {{${TEMPLATE_VARIABLES.at(-1) ?? ""}}}`;
const BRACES = "The braces do not match. Write variables as {{first_name}}";

const braced = (names: readonly string[]) => names.map((name) => `{{${name}}}`).join(", ");

interface TemplateRule {
  /** Shown when the template is empty; null when an empty template is allowed (it means no text). */
  readonly whenEmpty: string | null;
  readonly maxLength?: number;
  readonly aiPersonalise: boolean;
}

function templateProblem(template: string | null, rule: TemplateRule): string | null {
  if (template === null || template.trim() === "") return rule.whenEmpty;
  const used = variablesIn(template);
  const known: readonly string[] = TEMPLATE_VARIABLES;
  const unknown = used.filter((name) => !known.includes(name));
  if (unknown.length > 0) return `${braced(unknown)} ${unknown.length === 1 ? "is not a variable" : "are not variables"}. ${VARIABLE_LIST}`;
  if (!rule.aiPersonalise && used.includes("ai_line")) {
    return "{{ai_line}} is written by the AI only when personalisation is on. Turn it on or remove {{ai_line}}";
  }
  const rendered = renderTemplate(template, LONG_SAMPLE_VALUES);
  if (!rendered.ok) return rendered.problem === "malformed" ? BRACES : (rule.whenEmpty ?? "This text cannot be written");
  if (rule.maxLength !== undefined && rendered.text.length > rule.maxLength) {
    return `The invite note must be at most ${rule.maxLength} characters with the variables filled in. With long sample values it comes to ${rendered.text.length}.`;
  }
  return null;
}

/**
 * What stops this campaign from starting, by field; empty when it may start. Also used for edits
 * to a started campaign, so a live campaign never holds a template the engine would refuse.
 */
export function startProblems(c: CampaignFields): FieldProblems {
  const problems: Record<string, string> = {};
  const note = (field: string, problem: string | null) => {
    if (problem !== null) problems[field] = problem;
  };

  note("name", c.name.trim() === "" ? "Give the campaign a name" : null);
  if (c.discoverySource === "search") {
    if (c.sourceUrls.length === 0) note("sourceUrls", "Add at least one LinkedIn people-search URL");
    c.sourceUrls.forEach((url, index) =>
      note(
        `sourceUrls.${index}`,
        isPeopleSearchUrl(url) ? null : "This is not a LinkedIn people search. Copy the address of a search on www.linkedin.com/search/results/people/",
      ),
    );
  }
  note("scoringBrief", c.scoringBrief.trim() === "" ? "Describe who fits this campaign and who does not" : null);

  const ai = c.aiPersonalise;
  note("inviteNote", templateProblem(c.inviteNote, { whenEmpty: null, maxLength: INVITE_NOTE_MAX, aiPersonalise: ai }));
  note("firstMessage", templateProblem(c.firstMessage, { whenEmpty: "Write the first message", aiPersonalise: ai }));
  note("followUp", templateProblem(c.followUp, { whenEmpty: null, aiPersonalise: ai }));

  if (c.openProfileThreshold > c.scoreThreshold) {
    note("openProfileThreshold", `The open-profile threshold must not be above the score threshold (${c.scoreThreshold})`);
  }
  const longest = (max: number) => `The shortest wait must not be longer than the longest (${max} hours)`;
  if (c.acceptToMessageMinHours > c.acceptToMessageMaxHours) note("acceptToMessageMinHours", longest(c.acceptToMessageMaxHours));
  if (c.followUpDelayMinHours > c.followUpDelayMaxHours) note("followUpDelayMinHours", longest(c.followUpDelayMaxHours));

  return problems;
}

// ---------------------------------------------------------------- status moves

export type CampaignMove = "start" | "pause" | "resume" | "archive";

/** Statuses a campaign can be paused from, and so may be resumed to. */
export const PAUSABLE = ["finding", "awaiting_approval", "running"] as const satisfies readonly CampaignStatus[];
export type PausableStatus = (typeof PAUSABLE)[number];

export function isPausable(status: CampaignStatus): status is PausableStatus {
  return PAUSABLE.some((pausable) => pausable === status);
}

const words = (status: CampaignStatus) => status.replace(/_/g, " ");

/** Why the move is not allowed from `from`; null when it is. */
export function moveRefusal(move: CampaignMove, from: CampaignStatus): string | null {
  switch (move) {
    case "start":
      return from === "draft" ? null : `Only a draft can be started; this campaign is ${words(from)}`;
    case "pause":
      return isPausable(from) ? null : `Only a campaign that is finding, awaiting approval or running can be paused; this campaign is ${words(from)}`;
    case "resume":
      return from === "paused" ? null : `Only a paused campaign can be resumed; this campaign is ${words(from)}`;
    case "archive":
      return from === "archived" ? "This campaign is already archived" : null;
    default: {
      const _exhaustive: never = move;
      return _exhaustive;
    }
  }
}

/** Why this edit is not allowed for a campaign in `status`; null when it is. */
export function liveEditRefusal(status: CampaignStatus, patch: CampaignPatch): string | null {
  if (status === "draft") return null;
  if (status === "completed" || status === "archived") return `A${status === "archived" ? "n" : ""} ${status} campaign cannot be edited`;
  const allowed: readonly string[] = LIVE_EDITABLE_FIELDS;
  const refused = Object.entries(patch)
    .filter(([key, value]) => value !== undefined && !allowed.includes(key))
    .map(([key]) => key);
  return refused.length === 0 ? null : `Once a campaign has started only its templates and timings can change. These cannot: ${refused.join(", ")}`;
}

// ---------------------------------------------------------------- template preview

/** Invented values for a preview of a campaign that has found nobody yet. */
export const SAMPLE_VALUES = {
  first_name: "Anna",
  company: "Example Srl",
  title: "Operations Manager",
  location: "Milan, Italy",
  industry: "Manufacturing",
  ai_line: null,
} as const satisfies TemplateValues;

/** Shown in place of `{{ai_line}}` when personalisation is on and the AI has not written one yet. */
export const AI_LINE_STAND_IN = "[AI-written line]";

export type PreviewText =
  | { readonly ok: true; readonly text: string; readonly length: number }
  | {
      readonly ok: false;
      readonly problem: Extract<RenderResult, { ok: false }>["problem"];
      readonly variables: readonly string[];
      readonly message: string;
    };

export interface PreviewTemplates {
  readonly inviteNote: string | null;
  readonly firstMessage: string;
  readonly followUp: string;
  readonly aiPersonalise: boolean;
}

export interface Preview {
  /** Null when the campaign sends no note. */
  readonly inviteNote: PreviewText | null;
  readonly firstMessage: PreviewText;
  /** Null when the campaign has no follow-up. */
  readonly followUp: PreviewText | null;
}

function previewOne(template: string, values: TemplateValues, maxLength?: number): PreviewText {
  const rendered = renderTemplate(template, values);
  if (rendered.ok) {
    if (maxLength !== undefined && rendered.text.length > maxLength) {
      return { ok: false, problem: "too_long", variables: [], message: `Longer than ${maxLength} characters (${rendered.text.length})` };
    }
    return { ok: true, text: rendered.text, length: rendered.text.length };
  }
  const { problem, variables } = rendered;
  const message = {
    unresolved_variable: `No value for ${braced(variables)} for this person`,
    unknown_variable: `${braced(variables)} ${variables.length === 1 ? "is not a variable" : "are not variables"}`,
    malformed: BRACES,
    empty: "The text is empty",
    too_long: `Longer than ${maxLength ?? 0} characters`,
  }[problem];
  return { ok: false, problem, variables, message };
}

/**
 * The three texts as one person would receive them, or why each cannot be written. `values` are
 * the engine's for that person (`templateValues` in the engine). With `aiLineToCome` (the AI has
 * not had its turn at this person yet) and personalisation on, a missing AI line shows as
 * `AI_LINE_STAND_IN`; otherwise a missing line is unresolved, as the engine would find it.
 */
export function previewTexts(templates: PreviewTemplates, values: TemplateValues, { aiLineToCome }: { readonly aiLineToCome: boolean }): Preview {
  const standIn = aiLineToCome && templates.aiPersonalise && !values.ai_line?.trim();
  const filled: TemplateValues = standIn ? { ...values, ai_line: AI_LINE_STAND_IN } : values;
  const note = templates.inviteNote;
  return {
    inviteNote: note === null || note.trim() === "" ? null : previewOne(note, filled, INVITE_NOTE_MAX),
    firstMessage: previewOne(templates.firstMessage, filled),
    followUp: templates.followUp.trim() === "" ? null : previewOne(templates.followUp, filled),
  };
}
