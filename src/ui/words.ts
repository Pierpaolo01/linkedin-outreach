import type { CampaignStatus, ProspectStage } from "../db/schema";
import type { Budget, BudgetKind, Campaign, DiscoveryWait } from "./apiSchemas";
import { STEPS } from "./campaignForm";
import { formatClock, formatResume, formatWhen, NBSP, plural, STAGE_LABEL, unbroken, withStop } from "./format";

/** More words and dates for the campaign, activity, stats and settings pages. Times are in the app's time zone. */

const LOCALE = "en-GB";

export const FUNNEL = ["found", "approved", "invited", "accepted", "messaged", "replied"] as const;
export type FunnelStep = (typeof FUNNEL)[number];
export const FUNNEL_LABEL: Readonly<Record<FunnelStep, string>> = {
  found: "Found",
  approved: "Approved",
  invited: "Invited",
  accepted: "Accepted",
  messaged: "Messaged",
  replied: "Replied",
};

/** Statuses a campaign can be paused from. */
export const PAUSABLE: ReadonlySet<CampaignStatus> = new Set<CampaignStatus>(["finding", "awaiting_approval", "running"]);

/**
 * The Campaigns page's count: every campaign, and those at work (finding people, waiting for approval or running) as
 * active. During a safety stop none is at work, and the red banner right above and the table already say which it
 * halted, so the count is the number of campaigns alone.
 */
export function campaignsSummary(statuses: readonly CampaignStatus[], safetyStop: boolean): string {
  const all = plural(statuses.length, "campaign", "campaigns");
  if (safetyStop) return all;
  return `${all}, ${statuses.filter((status) => PAUSABLE.has(status)).length} active`;
}

/**
 * The line under a budget's meter on Home. A spent budget is never "paused" (pausing is the user's choice on one
 * campaign); it may be spent below today's number when the week's invite budget or LinkedIn's own limit blocks invites.
 * One form in every state: "Budget spent; it resets Monday 09:00" is true whether or not a safety stop holds the work,
 * so it never promises that work resumes.
 */
export function budgetNote(args: {
  readonly kind: BudgetKind;
  readonly budget: Budget;
  /** The invites a day warm-up rises to, when warm-up is on. */
  readonly warmUpTarget: number | undefined;
  readonly timeZone: string;
  readonly now: Date;
}): string | undefined {
  const { budget } = args;
  if (!budget.open) return budget.resumesAt === null ? "Budget spent" : `Budget spent; it resets ${formatResume(budget.resumesAt, args.timeZone, args.now)}`;
  if (args.kind === "invite" && args.warmUpTarget !== undefined && budget.limit < args.warmUpTarget) {
    return `Warm-up: today’s allowance, rising to ${args.warmUpTarget}${NBSP}a${NBSP}day`;
  }
  return undefined;
}

/** How a campaign's waits count days, as the end of a sentence. */
export const POLICY_WORDS = { calendar: "every day counts", working_days: "only working days count" } as const;

/** Started and not finished: its messages and timings can still change. */
export const LIVE: ReadonlySet<CampaignStatus> = new Set<CampaignStatus>(["finding", "awaiting_approval", "running", "paused"]);

/** Words with a capital first letter, for a value that stands on its own ("Every day counts"); the rest as it is. */
export function capitalised(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Accepted the invite": a stage as the start of a sentence or a table cell. */
export function stageWords(stage: ProspectStage): string {
  return capitalised(STAGE_LABEL[stage]);
}

/** "1 December 2026". */
export function formatDate(iso: string, timeZone: string): string {
  return unbroken(new Intl.DateTimeFormat(LOCALE, { timeZone, day: "numeric", month: "long", year: "numeric" }).format(new Date(iso)));
}

/** "12 Nov 10:42": a full timestamp for logs and histories. */
export function formatStamp(iso: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat(LOCALE, { timeZone, day: "numeric", month: "short" }).format(new Date(iso));
  return unbroken(`${day} ${formatClock(iso, timeZone)}`);
}

/**
 * Why finding new people waits, as a sentence. During a safety stop nothing resumes until the user does, so the
 * sentence says only what stays true either way (when LinkedIn's limit resets), never when the app looks again.
 */
export function discoveryWaitSentence(args: { readonly wait: DiscoveryWait; readonly timeZone: string; readonly safetyStop: boolean }): string {
  const { wait, safetyStop } = args;
  switch (wait.reason) {
    case "search_limit": {
      const date = formatDate(wait.until, args.timeZone);
      return safetyStop
        ? `LinkedIn’s monthly search limit is reached. It resets on ${date}.`
        : `Finding people is waiting: LinkedIn’s monthly search limit is reached. It resets on ${date}.`;
    }
    case "no_new_people":
      return safetyStop
        ? "LinkedIn’s recommendations showed nobody new today."
        : "Finding people is waiting: LinkedIn’s recommendations show nobody new today. The app looks again tomorrow.";
    case "unreadable":
      return safetyStop
        ? "The app could not read LinkedIn’s page; the activity log has the details."
        : "Finding people is waiting: the app could not read LinkedIn’s page. It looks again tomorrow; the activity log has the details.";
    case "exhausted":
      return "Finding people has stopped: there is nobody more to find from this campaign’s sources.";
    default: {
      const _exhaustive: never = wait;
      return _exhaustive;
    }
  }
}

/** "30 hours", "2.5 days". */
export function formatHours(hours: number): string {
  if (hours < 48) {
    const rounded = Math.round(hours);
    return plural(rounded, "hour", "hours");
  }
  return `${Math.round((hours / 24) * 10) / 10}${NBSP}days`;
}

/** "2.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}${NBSP}bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}${NBSP}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}${NBSP}MB`;
}

/** Stages that wait on the user's own decision (approve or reject, or choose in Needs review): the app plans nothing for them. */
const WAITS_ON_USER: ReadonlySet<ProspectStage> = new Set<ProspectStage>(["pending_approval", "needs_review"]);

/**
 * When a prospect's next step is planned, as a value in the People table's column (so with a capital, like the
 * column's other values): "Today at 10:42", or "Due now" when the moment has passed. During a safety stop no step of
 * the app's is sent at its time, so it says "After you resume" instead of a time that would not hold; a person who
 * waits on the user's own decision is not waiting for the resume, so the cell shows nothing planned (undefined), as
 * it does for anyone without a next step.
 */
export function nextActionWhen(args: {
  readonly at: string;
  readonly stage: ProspectStage;
  readonly timeZone: string;
  readonly now: Date;
  readonly safetyStop: boolean;
}): string | undefined {
  if (args.safetyStop) return WAITS_ON_USER.has(args.stage) ? undefined : "After you resume";
  return new Date(args.at).getTime() <= args.now.getTime() ? "Due now" : capitalised(formatWhen(args.at, args.timeZone, args.now));
}

/** What the app does next for a prospect in this stage; undefined when nothing more is planned. */
export function nextStepWords(stage: ProspectStage, campaign: Pick<Campaign, "followUp">): string | undefined {
  switch (stage) {
    case "approved":
      return "Invite";
    case "invited":
      return "Check whether they accepted";
    case "accepted":
      return "First message";
    case "message_sent":
      return campaign.followUp.trim() === "" ? "Finish" : "Follow-up";
    default:
      return undefined;
  }
}

/** A session state as the end of "Checked LinkedIn: …". */
const SESSION_WORDS: Readonly<Record<string, string>> = {
  ok: "logged in",
  logged_out: "logged out",
  checkpoint: "it asks for a security check",
  restricted: "it shows a restriction or warning",
  search_capped: "logged in, search limit reached",
  unknown: "could not tell whether it is logged in",
};
const sessionWords = (status: string) => SESSION_WORDS[status] ?? status.replace(/_/g, " ");

/** "acceptToMessageMinHours" as "accept to message min hours": a field the dashboard has no step for. */
const keyWords = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();

/** The campaign's fields an edit changed, as the wizard's step names in the wizard's order ("Messages, Timings"). */
function editedWords(keys: string): string {
  const names = keys.split(",").map((key) => key.trim()).filter((key) => key !== "");
  if (names.length === 1 && names[0] === "nothing") return "nothing";
  const steps = STEPS.filter((step) => names.some((key) => (step.keys as readonly string[]).includes(key))).map((step) => step.title);
  const known = new Set<string>(STEPS.flatMap((step) => step.keys));
  const other = names.filter((key) => !known.has(key)).map(keyWords);
  return [...new Set([...steps, ...other])].join(", ");
}

/** How a line names its campaign, as the server writes it. */
type CampaignLead = "campaign" | "discovery" | "completed";

/**
 * A line that leads with its campaign: `Campaign "N" …` (or the demo's unquoted `Campaign N …`), `Discovery for N: …`
 * and `N completed: …`. Found by the campaign's name when the page knows it, else by the quotes the server puts round it.
 */
function campaignLead(text: string, name: string | undefined): { readonly name: string; readonly lead: CampaignLead; readonly rest: string } | null {
  if (name !== undefined && name !== "") {
    const forms: readonly (readonly [string, CampaignLead])[] = [
      [`Campaign "${name}" `, "campaign"],
      [`Campaign ${name} `, "campaign"],
      [`Discovery for ${name}: `, "discovery"],
      [`Discovery for "${name}": `, "discovery"],
      [`${name} completed: `, "completed"],
      [`"${name}" completed: `, "completed"],
    ];
    for (const [prefix, lead] of forms) if (text.startsWith(prefix)) return { name, lead, rest: text.slice(prefix.length) };
  }
  const quoted = /^Campaign "(.*)" (.+)$/s.exec(text);
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) return { name: quoted[1], lead: "campaign", rest: quoted[2] };
  return null;
}

/** A campaign line in the app's words: without its name when the row shows the campaign beside it, else with the name in quotes. */
function campaignLine(line: { readonly name: string; readonly lead: CampaignLead; readonly rest: string }, shown: boolean): string {
  const rest = line.rest.replace(/_/g, " ");
  const quoted = `"${line.name}"`;
  switch (line.lead) {
    case "discovery":
      return shown ? `Discovery: ${rest}` : `Discovery for ${quoted}: ${rest}`;
    case "completed":
      return shown ? `Completed: ${rest}` : `${quoted} completed: ${rest}`;
    case "campaign": {
      const edited = /^edited: ([\w, ]+)$/.exec(line.rest);
      if (edited?.[1] !== undefined) return shown ? `Edited: ${editedWords(edited[1])}.` : `Campaign ${quoted} edited: ${editedWords(edited[1])}.`;
      if (line.rest === "running: a prospect was approved") {
        return shown ? "A prospect was approved, so the campaign is running." : `A prospect was approved in ${quoted}, so the campaign is running.`;
      }
      return shown ? `${capitalised(rest)}.` : `Campaign ${quoted} ${rest}`;
    }
    default: {
      const _exhaustive: never = line.lead;
      return _exhaustive;
    }
  }
}

/**
 * A message from the engine as the activity log and Home show it: without underscores, and with the server
 * lines that read as log keys put in the app's words ("LinkedIn session: ok" is "Checked LinkedIn: logged in.";
 * a campaign edit names the wizard's steps, not field keys; a reached daily limit is "the daily budget … is
 * spent", as Home says it, without "today's", since the line may be from an earlier day; a campaign that starts
 * running on an approval says so as a sentence). A line about one campaign does not name it again where the row
 * shows the campaign beside it (`campaignShown`, the activity log); elsewhere (Home) the name stays, in quotes.
 * Every line ends as a sentence, with one full stop (`withStop`), whether the app rewrote it or passed it through.
 * The server's own strings stay as they are (backlog D-10).
 */
export function plainMessage(text: string, where: { readonly campaign?: string | undefined; readonly campaignShown?: boolean } = {}): string {
  return withStop(plainWords(text, where));
}

/** `plainMessage` before its ending is made a sentence's. */
function plainWords(text: string, where: { readonly campaign?: string | undefined; readonly campaignShown?: boolean }): string {
  const session = /^LinkedIn session: (\w+)$/.exec(text);
  if (session?.[1] !== undefined) return `Checked LinkedIn: ${sessionWords(session[1])}.`;
  const lead = campaignLead(text, where.campaign);
  if (lead !== null) return campaignLine(lead, where.campaignShown === true);
  const limit = /the (daily|weekly) limit of (\d+) (.+?) is reached/.exec(text);
  if (limit !== null) {
    const [phrase, period, count, what] = limit;
    const spent = `the ${period} budget of ${count} ${what} is spent`;
    return text.replace(phrase, spent).replace(/^Discovery paused:/, "Discovery waits:").replace(/_/g, " ");
  }
  const outside = /^Outside working hours: (.*)$/.exec(text);
  if (outside?.[1] !== undefined) {
    const rest = outside[1].replace(/last known: (\w+)/, (_, status: string) => `last known: ${sessionWords(status)}`);
    return `Outside the working window: ${rest.replace(/_/g, " ")}`;
  }
  return text.replace(/_/g, " ");
}

/**
 * A failed action as the user reads it: `text` says what failed, what state things are in and what to do, in the app's
 * words; `detail` is what was said about it, shown apart and quieter, never glued on: "What the app said: …" for the
 * app's own answer, or the dashboard's sentence when the app did not answer at all.
 */
export interface Failure {
  readonly text: string;
  readonly detail: string | undefined;
}

/** What came back about a failure: the app's answer, or (status 0) the dashboard's own sentence when it did not answer. */
export interface Said {
  readonly message: string;
  readonly status: number;
}

/** A failure with what was said about it (`said`: an answer, or the app's message as a string) as a sentence's end, apart. */
export function failure(text: string, said?: Said | string): Failure {
  const { message, status } = typeof said === "string" ? { message: said, status: 200 } : (said ?? { message: "", status: 200 });
  const words = withStop(message);
  if (words === "") return { text, detail: undefined };
  return { text, detail: status === 0 ? words : `What the app said: ${words}` };
}

/** A Pause or Resume that failed, on a campaign named `name` (undefined on the campaign's own page). */
export function toggleFailure(args: { readonly name: string | undefined; readonly resuming: boolean; readonly said: Said }): Failure {
  const which = args.name === undefined ? "The campaign" : `Campaign "${args.name}"`;
  return failure(
    args.resuming ? `${which} was not resumed. It is still paused; press Resume again.` : `${which} was not paused. Nothing changed; press Pause again.`,
    args.said,
  );
}
