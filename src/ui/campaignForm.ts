import type { Campaign, CampaignFields } from "./apiSchemas";

/**
 * The campaign form as the wizard and the live-edit form hold it: numbers as typed (text), so a
 * half-typed value stays on screen, and turned into the API's fields only when saved.
 */
export interface CampaignForm {
  readonly name: string;
  readonly discoverySource: Campaign["discoverySource"];
  readonly sourceUrls: readonly string[];
  readonly targetProspectCount: string;
  readonly scoringBrief: string;
  readonly batchSize: string;
  readonly autoApprove: boolean;
  readonly scoreThreshold: string;
  readonly openProfileThreshold: string;
  readonly inviteNote: string;
  readonly firstMessage: string;
  readonly followUp: string;
  readonly aiPersonalise: boolean;
  readonly personalisationInstructions: string;
  readonly acceptToMessageMinHours: string;
  readonly acceptToMessageMaxHours: string;
  readonly followUpDelayMinHours: string;
  readonly followUpDelayMaxHours: string;
  readonly delayPolicy: Campaign["delayPolicy"];
  readonly withdrawAfterDays: string;
}

export type FormKey = keyof CampaignForm;
export type SetField = <K extends FormKey>(key: K, value: CampaignForm[K]) => void;
/** Field path (dotted, as the server sends them: `sourceUrls.1`) → what to do about it. */
export type FieldErrors = Readonly<Record<string, string>>;

/** Before the campaign exists, only its name is asked for; the rest arrives with the server's defaults. */
export const BLANK_FORM: CampaignForm = {
  name: "",
  discoverySource: "recommendations",
  sourceUrls: [],
  targetProspectCount: "",
  scoringBrief: "",
  batchSize: "",
  autoApprove: false,
  scoreThreshold: "",
  openProfileThreshold: "",
  inviteNote: "",
  firstMessage: "",
  followUp: "",
  aiPersonalise: false,
  personalisationInstructions: "",
  acceptToMessageMinHours: "",
  acceptToMessageMaxHours: "",
  followUpDelayMinHours: "",
  followUpDelayMaxHours: "",
  delayPolicy: "calendar",
  withdrawAfterDays: "",
};

export function formFromCampaign(c: Campaign): CampaignForm {
  return {
    name: c.name,
    discoverySource: c.discoverySource,
    sourceUrls: c.sourceUrls,
    targetProspectCount: c.targetProspectCount === null ? "" : String(c.targetProspectCount),
    scoringBrief: c.scoringBrief,
    batchSize: String(c.batchSize),
    autoApprove: c.autoApprove,
    scoreThreshold: String(c.scoreThreshold),
    openProfileThreshold: String(c.openProfileThreshold),
    inviteNote: c.inviteNote ?? "",
    firstMessage: c.firstMessage,
    followUp: c.followUp,
    aiPersonalise: c.aiPersonalise,
    personalisationInstructions: c.personalisationInstructions ?? "",
    acceptToMessageMinHours: String(c.acceptToMessageMinHours),
    acceptToMessageMaxHours: String(c.acceptToMessageMaxHours),
    followUpDelayMinHours: String(c.followUpDelayMinHours),
    followUpDelayMaxHours: String(c.followUpDelayMaxHours),
    delayPolicy: c.delayPolicy,
    withdrawAfterDays: String(c.withdrawAfterDays),
  };
}

/** The wizard's six steps, each with the fields it asks for. */
export const STEPS = [
  { title: "Name", keys: ["name"] },
  { title: "Where people come from", keys: ["discoverySource", "sourceUrls", "targetProspectCount"] },
  { title: "Who fits", keys: ["scoringBrief"] },
  { title: "Approval", keys: ["batchSize", "autoApprove", "scoreThreshold", "openProfileThreshold"] },
  { title: "Messages", keys: ["inviteNote", "firstMessage", "followUp", "aiPersonalise", "personalisationInstructions"] },
  {
    title: "Timings",
    keys: [
      "acceptToMessageMinHours",
      "acceptToMessageMaxHours",
      "followUpDelayMinHours",
      "followUpDelayMaxHours",
      "delayPolicy",
      "withdrawAfterDays",
    ],
  },
] as const satisfies readonly { readonly title: string; readonly keys: readonly FormKey[] }[];

/** The fields a started campaign may still change: its messages and timings. */
export const LIVE_KEYS = [...STEPS[4].keys, ...STEPS[5].keys] as const satisfies readonly FormKey[];

/** The step (0-based) a field path belongs to; the last step when it is not a form field. */
export function stepOf(path: string): number {
  const key = path.split(".")[0] ?? "";
  const index = STEPS.findIndex((step) => (step.keys as readonly string[]).includes(key));
  return index === -1 ? STEPS.length : index;
}

/** The fields' names as the review page lists their problems. */
export const FIELD_LABEL: Readonly<Record<FormKey, string>> = {
  name: "Name",
  discoverySource: "Where people come from",
  sourceUrls: "Search addresses",
  targetProspectCount: "How many people to find",
  scoringBrief: "Who fits",
  batchSize: "Batch size",
  autoApprove: "Auto-approve",
  scoreThreshold: "Score threshold",
  openProfileThreshold: "Open-profile threshold",
  inviteNote: "Invite note",
  firstMessage: "First message",
  followUp: "Follow-up",
  aiPersonalise: "AI-written line",
  personalisationInstructions: "Instructions for the AI line",
  acceptToMessageMinHours: "Wait before the first message",
  acceptToMessageMaxHours: "Wait before the first message",
  followUpDelayMinHours: "Wait before the follow-up",
  followUpDelayMaxHours: "Wait before the follow-up",
  delayPolicy: "How the waits count days",
  withdrawAfterDays: "Withdraw unanswered invites",
};

const NUMBER_KEYS = new Set<FormKey>([
  "batchSize",
  "scoreThreshold",
  "openProfileThreshold",
  "acceptToMessageMinHours",
  "acceptToMessageMaxHours",
  "followUpDelayMinHours",
  "followUpDelayMaxHours",
  "withdrawAfterDays",
]);

/** The non-empty search addresses, in order: what is sent, so `sourceUrls.<i>` counts these. */
export function sentUrls(urls: readonly string[]): string[] {
  return urls.map((url) => url.trim()).filter((url) => url !== "");
}

/**
 * The API fields for `keys`, or the fields that are not numbers. Everything else (ranges, whole
 * numbers, the template rules) is checked by the app, whose messages are shown as they come.
 */
export function toFields(form: CampaignForm, keys: readonly FormKey[]): { readonly fields: CampaignFields; readonly errors: FieldErrors } {
  const fields: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const key of keys) {
    const value = form[key];
    if (key === "targetProspectCount") {
      const text = form.targetProspectCount.trim();
      if (text === "") fields[key] = null;
      else if (Number.isFinite(Number(text))) fields[key] = Number(text);
      else errors[key] = "Enter a number, or leave it empty";
    } else if (NUMBER_KEYS.has(key) && typeof value === "string") {
      const text = value.trim();
      if (text !== "" && Number.isFinite(Number(text))) fields[key] = Number(text);
      else errors[key] = "Enter a number";
    } else if (key === "sourceUrls") {
      fields[key] = sentUrls(form.sourceUrls);
    } else if (key === "inviteNote" || key === "personalisationInstructions") {
      fields[key] = form[key].trim() === "" ? null : form[key];
    } else {
      fields[key] = value;
    }
  }
  // Built key by key from the form's own fields above, so it holds only CampaignFields keys.
  return { fields: fields as CampaignFields, errors };
}

/** The errors without those for `key` (and its sub-paths, such as `sourceUrls.2`). */
export function withoutErrors(errors: FieldErrors, key: string): FieldErrors {
  return Object.fromEntries(Object.entries(errors).filter(([path]) => path !== key && !path.startsWith(`${key}.`)));
}

/** The template variables he can use, with the words shown on their chips. */
export const VARIABLES = [
  { name: "first_name", label: "First name" },
  { name: "company", label: "Company" },
  { name: "title", label: "Job title" },
  { name: "location", label: "Location" },
  { name: "industry", label: "Industry" },
  { name: "ai_line", label: "AI-written line" },
] as const;

export const INVITE_NOTE_MAX = 300;
