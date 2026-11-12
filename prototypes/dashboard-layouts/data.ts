// PROTOTYPE data. Every name, company and message is invented. No real people.

export type ScreenKey =
  | "home"
  | "campaigns"
  | "campaign"
  | "approvals"
  | "review"
  | "activity"
  | "stats"
  | "settings";

/** The eight screens of spec section 10. "campaign" (Campaign detail) is reached through a campaign. */
export const SCREENS: readonly { key: ScreenKey; label: string }[] = [
  { key: "home", label: "Home" },
  { key: "campaigns", label: "Campaigns" },
  { key: "campaign", label: "Campaign detail" },
  { key: "approvals", label: "Approval queue" },
  { key: "review", label: "Needs review" },
  { key: "activity", label: "Activity log" },
  { key: "stats", label: "Stats" },
  { key: "settings", label: "Settings" },
];

export type CampaignStatus = "running" | "paused" | "finding";

export interface Campaign {
  readonly id: string;
  readonly name: string;
  readonly status: CampaignStatus;
  readonly found: number;
  readonly approved: number;
  readonly invited: number;
  readonly accepted: number;
  readonly messaged: number;
  readonly replied: number;
  readonly waiting: number;
  readonly today: string;
}

export const CAMPAIGNS: readonly Campaign[] = [
  {
    id: "hotels",
    name: "Hotel owners, Rome",
    status: "running",
    found: 64,
    approved: 31,
    invited: 27,
    accepted: 11,
    messaged: 9,
    replied: 2,
    waiting: 5,
    today: "6 invites and 4 messages sent today",
  },
  {
    id: "trades",
    name: "Local trades, Milan",
    status: "finding",
    found: 22,
    approved: 6,
    invited: 3,
    accepted: 1,
    messaged: 0,
    replied: 0,
    waiting: 3,
    today: "Scoring new people from recommendations",
  },
  {
    id: "restaurants",
    name: "Restaurants, Naples",
    status: "paused",
    found: 40,
    approved: 18,
    invited: 18,
    accepted: 7,
    messaged: 7,
    replied: 1,
    waiting: 0,
    today: "Paused by you on 9 November",
  },
];

export const STATUS_LABEL: Readonly<Record<CampaignStatus, string>> = {
  running: "Running",
  finding: "Finding people",
  paused: "Paused",
};

export interface Usage {
  readonly key: string;
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly week?: { readonly used: number; readonly limit: number };
  readonly note?: string;
}

export const USAGE: readonly Usage[] = [
  { key: "invites", label: "Invites", used: 9, limit: 15, week: { used: 41, limit: 80 } },
  { key: "messages", label: "Messages", used: 6, limit: 10 },
  { key: "views", label: "Profile views", used: 22, limit: 40 },
  {
    key: "discovery",
    label: "Discovery pages",
    used: 10,
    limit: 10,
    note: "Limit reached, resumes tomorrow 09:00",
  },
  { key: "withdrawals", label: "Withdrawals", used: 2, limit: 10 },
];

export interface Prospect {
  readonly id: number;
  readonly name: string;
  readonly headline: string;
  readonly company: string;
  readonly location: string;
  readonly score: number;
  readonly reason: string;
  readonly message: string;
  readonly campaign: string;
}

function sample(company: string): string {
  return `Hi Test, thanks for connecting. This is sample text: your first-message template appears here, filled in for ${company}.`;
}

export const PROSPECTS: readonly Prospect[] = [
  {
    id: 1,
    name: "Test Person 1",
    headline: "Owner and host at Hotel Esempio",
    company: "Hotel Esempio",
    location: "Rome, Italy",
    score: 9,
    reason: "Owns a 24-room independent hotel in central Rome. Matches \"independent hotel owners\" exactly.",
    message: sample("Hotel Esempio"),
    campaign: "Hotel owners, Rome",
  },
  {
    id: 2,
    name: "Test Person 2",
    headline: "Founder, Villa Campione boutique rooms",
    company: "Villa Campione",
    location: "Rome, Italy",
    score: 8,
    reason: "Founder of a small guesthouse group. Posts about direct bookings, a positive signal in your brief.",
    message: sample("Villa Campione"),
    campaign: "Hotel owners, Rome",
  },
  {
    id: 3,
    name: "Test Person 3",
    headline: "Titolare, Impianti Prova Srl",
    company: "Impianti Prova Srl",
    location: "Milan, Italy",
    score: 8,
    reason: "Runs a 12-person plumbing and heating firm. Owner title confirmed on the profile.",
    message: sample("Impianti Prova"),
    campaign: "Local trades, Milan",
  },
  {
    id: 4,
    name: "Test Person 4",
    headline: "General manager at Albergo Modello",
    company: "Albergo Modello",
    location: "Frascati, Italy",
    score: 7,
    reason: "Manages, not owns, a family hotel. Your brief accepts general managers of independent hotels.",
    message: sample("Albergo Modello"),
    campaign: "Hotel owners, Rome",
  },
  {
    id: 5,
    name: "Test Person 5",
    headline: "Electrician and owner, Elettro Demo",
    company: "Elettro Demo",
    location: "Monza, Italy",
    score: 7,
    reason: "Sole-trader electrician just outside Milan. Fits the trades brief; very small company.",
    message: sample("Elettro Demo"),
    campaign: "Local trades, Milan",
  },
  {
    id: 6,
    name: "Test Person 6",
    headline: "Revenue manager, Gruppo Ospitalità Test",
    company: "Gruppo Ospitalità Test",
    location: "Rome, Italy",
    score: 6,
    reason: "Works for a 9-hotel group. Not an owner, and your brief prefers single properties.",
    message: sample("Gruppo Ospitalità Test"),
    campaign: "Hotel owners, Rome",
  },
  {
    id: 7,
    name: "Test Person 7",
    headline: "Co-owner, Bed and Breakfast Finto",
    company: "B&B Finto",
    location: "Tivoli, Italy",
    score: 5,
    reason: "Owner, but runs three rooms. Below the size your brief asks for.",
    message: sample("B&B Finto"),
    campaign: "Hotel owners, Rome",
  },
  {
    id: 8,
    name: "Test Person 8",
    headline: "Sales director, Edilizia Campione SpA",
    company: "Edilizia Campione SpA",
    location: "Milan, Italy",
    score: 4,
    reason: "Sales role at a 300-person construction company. Your brief excludes large firms.",
    message: sample("Edilizia Campione"),
    campaign: "Local trades, Milan",
  },
];

export interface ReviewItem {
  readonly name: string;
  readonly campaign: string;
  readonly reason: string;
  readonly since: string;
}

export const NEEDS_REVIEW: readonly ReviewItem[] = [
  {
    name: "Test Person 9",
    campaign: "Hotel owners, Rome",
    reason: "The first message would go out with an empty company name.",
    since: "10:12",
  },
  {
    name: "Test Person 10",
    campaign: "Local trades, Milan",
    reason: "The profile page did not look as expected. A screenshot is saved.",
    since: "09:47",
  },
];

export interface ActivityItem {
  readonly time: string;
  readonly text: string;
  readonly result: "ok" | "deferred" | "failed";
}

export const ACTIVITY: readonly ActivityItem[] = [
  { time: "10:41", text: "Sent the first message to Test Person 21", result: "ok" },
  { time: "10:37", text: "Sent an invite to Test Person 22", result: "ok" },
  { time: "10:33", text: "Test Person 23 accepted your invite", result: "ok" },
  { time: "10:30", text: "Discovery paused: daily limit of 10 pages reached", result: "deferred" },
  { time: "10:26", text: "Viewed the profile of Test Person 24", result: "ok" },
  { time: "10:19", text: "Withdrew the invite to Test Person 25 after 21 days", result: "ok" },
];

export const SESSION = {
  ok: {
    label: "Connected",
    line: "The dedicated window is logged in to LinkedIn.",
    checked: "Last checked 10:42",
  },
  stop: {
    label: "Checkpoint",
    line: "LinkedIn is asking for a security check.",
    banner:
      "LinkedIn is asking for a security check in the dedicated window. Complete it there yourself, then press Re-check.",
    checked: "Raised 10:44",
  },
} as const;

export const TODAY = "Thursday 12 November";
export const WORKING = "Working Mon to Fri, 09:00 to 18:00";

export function scoreTone(score: number): "high" | "mid" | "low" {
  if (score >= 7) return "high";
  if (score >= 5) return "mid";
  return "low";
}
