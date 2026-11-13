import type { CampaignStatus, ProspectStage } from "../db/schema";
import type { Campaign, DiscoveryWait } from "./apiSchemas";
import { STEPS } from "./campaignForm";
import { formatClock, formatWhen, STAGE_LABEL } from "./format";

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
  return new Intl.DateTimeFormat(LOCALE, { timeZone, day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));
}

/** "12 Nov 10:42": a full timestamp for logs and histories. */
export function formatStamp(iso: string, timeZone: string): string {
  const day = new Intl.DateTimeFormat(LOCALE, { timeZone, day: "numeric", month: "short" }).format(new Date(iso));
  return `${day} ${formatClock(iso, timeZone)}`;
}

/** Why finding new people waits, as a sentence. */
export function discoveryWaitSentence(wait: DiscoveryWait, timeZone: string): string {
  switch (wait.reason) {
    case "search_limit":
      return `Finding people is waiting: LinkedIn's monthly search limit is reached. It resumes on ${formatDate(wait.until, timeZone)}.`;
    case "no_new_people":
      return "Finding people is waiting: LinkedIn's recommendations show nobody new today. The app looks again tomorrow.";
    case "unreadable":
      return "Finding people is waiting: the app could not read LinkedIn's page. It looks again tomorrow; the activity log has the details.";
    case "exhausted":
      return "Finding people has stopped: there is nobody more to find from this campaign's sources.";
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
    return `${rounded} ${rounded === 1 ? "hour" : "hours"}`;
  }
  const days = Math.round((hours / 24) * 10) / 10;
  return `${days} days`;
}

/** "2.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "today at 10:42", or "due now" when the moment has passed. */
export function formatNext(iso: string, timeZone: string, now: Date): string {
  return new Date(iso).getTime() <= now.getTime() ? "due now" : formatWhen(iso, timeZone, now);
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

/**
 * A message from the engine as the activity log and Home show it: without underscores, and with the server
 * lines that read as log keys put in the app's words ("LinkedIn session: ok" is "Checked LinkedIn: logged in.";
 * a campaign edit names the wizard's steps, not field keys; a reached daily limit is "the daily budget … is
 * spent", as Home says it, without "today's", since the line may be from an earlier day; a campaign that starts
 * running on an approval says so as a sentence). The server's own strings stay as they are (backlog D-10).
 */
export function plainMessage(text: string): string {
  const session = /^LinkedIn session: (\w+)$/.exec(text);
  if (session?.[1] !== undefined) return `Checked LinkedIn: ${sessionWords(session[1])}.`;
  const edited = /^(Campaign ".*" edited): ([\w, ]+)$/.exec(text);
  if (edited?.[1] !== undefined && edited[2] !== undefined) return `${edited[1]}: ${editedWords(edited[2])}.`;
  const running = /^Campaign (".*") running: a prospect was approved$/.exec(text);
  if (running?.[1] !== undefined) return `A prospect was approved in ${running[1]}, so the campaign is running.`;
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
