import type { CampaignStatus, ProspectStage } from "../db/schema";
import type { Campaign, DiscoveryWait } from "./apiSchemas";
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

/** Started and not finished: its messages and timings can still change. */
export const LIVE: ReadonlySet<CampaignStatus> = new Set<CampaignStatus>(["finding", "awaiting_approval", "running", "paused"]);

/** "Accepted the invite": a stage as the start of a sentence or a table cell. */
export function stageWords(stage: ProspectStage): string {
  const words = STAGE_LABEL[stage];
  return words.charAt(0).toUpperCase() + words.slice(1);
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

/** A message from the engine, without underscores, as the activity log and Home show it. */
export function plainMessage(text: string): string {
  return text.replace(/_/g, " ");
}
