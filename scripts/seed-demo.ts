/**
 * Fills an empty data directory with invented data for demos, screenshots and the dashboard
 * browser tests: five campaigns in different statuses (one a draft), 70 invented people, prospects
 * across the stages (8 waiting for approval, 2 in needs review), some of today's ledger rows and
 * activity lines, and two campaigns whose discovery waits (LinkedIn's search limit; nobody left).
 *
 *   LINKEDIN_OUTREACH_DATA_DIR=/tmp/demo tsx scripts/seed-demo.ts [--safety-stop]
 *
 * `--safety-stop` also raises an active safety stop (a checkpoint).
 *
 * It refuses unless LINKEDIN_OUTREACH_DATA_DIR names a scratch folder (set, and not the default data
 * directory, whatever that holds), and when the database already holds any campaign or person, so
 * it can never touch real data. Every name, company and text here is invented.
 */
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { count } from "drizzle-orm";
import { dataPaths } from "../src/config/paths";
import { scratchDataDirProblem } from "../src/worker/env";
import { getSettings } from "../src/config/settings";
import { ensureDataDir, openDb } from "../src/db/index";
import {
  actions,
  campaigns,
  discoveryRuns,
  eventLog,
  people,
  prospects,
  safetyStops,
  type ActionType,
  type EventLevel,
  type ProspectStage,
} from "../src/db/schema";
import { startOfNextMonth } from "../src/engine/discovery";
import type { Conn } from "../src/engine/ledger";
import { startOfDay } from "../src/engine/workingWindow";

const { values: flags } = parseArgs({ options: { "safety-stop": { type: "boolean", default: false } } });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface PersonSeed {
  readonly company: string;
  readonly title: string;
  readonly location: string;
  readonly industry: string;
  readonly size: string;
}

interface ProspectSeed {
  readonly stage: ProspectStage;
  readonly score?: number;
  readonly reason?: string;
  readonly reviewReason?: string;
  readonly person: PersonSeed;
}

interface CampaignSeed {
  readonly name: string;
  readonly status: "running" | "awaiting_approval" | "paused" | "finding" | "draft";
  readonly brief: string;
  readonly inviteNote: string | null;
  readonly firstMessage: string;
  readonly followUp: string;
  readonly ageDays: number;
  readonly prospects: readonly ProspectSeed[];
}

const hotel = (company: string, title: string, location = "Rome, Italy", size = "11-50 employees"): PersonSeed => ({
  company,
  title,
  location,
  industry: "Hospitality",
  size,
});
const trade = (company: string, title: string, location = "Milan, Italy", size = "2-10 employees"): PersonSeed => ({
  company,
  title,
  location,
  industry: "Construction",
  size,
});
const food = (company: string, title: string, location = "Naples, Italy"): PersonSeed => ({
  company,
  title,
  location,
  industry: "Restaurants",
  size: "11-50 employees",
});

const studio = (n: number): PersonSeed => ({
  company: `Studio Esempio ${n}`,
  title: n % 3 === 0 ? "Partner" : n % 3 === 1 ? "Founder" : "Architect",
  location: "Turin, Italy",
  industry: "Architecture and Planning",
  size: "2-10 employees",
});

/** Thirty people the architects campaign found: unscored, scored below the line, and turned down. */
const ARCHITECTS: readonly ProspectSeed[] = Array.from({ length: 30 }, (_, i): ProspectSeed => {
  if (i < 12) return { stage: "found", person: studio(i + 1) };
  if (i < 20) return { stage: "scored", score: 4 + (i % 3), reason: "Runs a small studio; the profile says little about the kind of projects.", person: studio(i + 1) };
  return { stage: "rejected", score: 1 + (i % 3), reason: "Works for a large engineering group, which the brief leaves out.", person: studio(i + 1) };
});

const CAMPAIGNS: readonly CampaignSeed[] = [
  {
    name: "Hotel owners, Rome",
    status: "running",
    brief: "Owners and general managers of independent hotels in and around Rome, 10 to 60 rooms. Not hotel chains or groups.",
    inviteNote: "Hi {{first_name}}, I work with independent hotels in Rome and would like to connect.",
    firstMessage: "Thanks for connecting, {{first_name}}. I help independent hotels like {{company}} take more direct bookings. Would a short call next week be useful?",
    followUp: "Hi {{first_name}}, just checking whether my last message reached you.",
    ageDays: 18,
    prospects: [
      { stage: "pending_approval", score: 9, reason: "Owns a 24-room independent hotel in central Rome. Matches \"independent hotel owners\" exactly.", person: hotel("Hotel Esempio", "Owner and host") },
      { stage: "pending_approval", score: 8, reason: "Founder of a small guesthouse group. Posts about direct bookings, a positive signal in your brief.", person: hotel("Villa Campione", "Founder") },
      { stage: "pending_approval", score: 7, reason: "Manages, not owns, a family hotel. Your brief accepts general managers of independent hotels.", person: hotel("Albergo Modello", "General manager", "Frascati, Italy") },
      { stage: "pending_approval", score: 6, reason: "Works for a 9-hotel group. Not an owner, and your brief prefers single properties.", person: hotel("Gruppo Ospitalità Test", "Revenue manager", "Rome, Italy", "201-500 employees") },
      { stage: "pending_approval", score: 5, reason: "Owner, but runs three rooms. Below the size your brief asks for.", person: hotel("B&B Finto", "Co-owner", "Tivoli, Italy", "1 employee") },
      { stage: "needs_review", score: 8, reason: "Owner of a 30-room hotel near Termini.", reviewReason: "tried 3 times without a confirmed result", person: hotel("Hotel Prova Termini", "Owner") },
      { stage: "approved", score: 8, reason: "Owner of a boutique hotel in Trastevere.", person: hotel("Residenza Demo", "Owner") },
      { stage: "approved", score: 7, reason: "General manager of an independent hotel.", person: hotel("Hotel Campione Roma", "General manager") },
      { stage: "approved", score: 9, reason: "Third-generation owner of a family hotel.", person: hotel("Albergo Esempio Antico", "Owner") },
      { stage: "invited", score: 8, reason: "Owner of a 40-room hotel.", person: hotel("Hotel Modello Centro", "Owner") },
      { stage: "invited", score: 7, reason: "Co-founder of a guesthouse.", person: hotel("Casa Prova", "Co-founder") },
      { stage: "invited", score: 8, reason: "Owner of an independent hotel near the Vatican.", person: hotel("Hotel Finto San Pietro", "Owner") },
      { stage: "invited", score: 7, reason: "Managing director of a family hotel.", person: hotel("Hotel Demo Flaminio", "Managing director") },
      { stage: "accepted", score: 9, reason: "Owner of a 20-room hotel.", person: hotel("Hotel Test Pantheon", "Owner") },
      { stage: "accepted", score: 8, reason: "General manager of an independent hotel.", person: hotel("Hotel Esempio Prati", "General manager") },
      { stage: "message_sent", score: 8, reason: "Owner of a hotel in Monti.", person: hotel("Hotel Monti Prova", "Owner") },
      { stage: "message_sent", score: 7, reason: "Owner of a small hotel.", person: hotel("Piccolo Hotel Demo", "Owner") },
      { stage: "follow_up_sent", score: 8, reason: "Founder of a boutique hotel.", person: hotel("Boutique Hotel Finto", "Founder") },
      { stage: "stopped", score: 9, reason: "Owner of a hotel near Piazza Navona.", person: hotel("Hotel Navona Test", "Owner") },
      { stage: "rejected", score: 3, reason: "Works at a large international chain.", person: hotel("Catena Alberghiera Esempio", "Sales manager", "Rome, Italy", "1001-5000 employees") },
    ],
  },
  {
    name: "Local trades, Milan",
    status: "awaiting_approval",
    brief: "Owners of small plumbing, electrical and building firms in Milan and nearby towns, under 20 people.",
    inviteNote: null,
    firstMessage: "Thanks for connecting, {{first_name}}. I work with small firms like {{company}} on getting more local jobs. Is that something you think about?",
    followUp: "",
    ageDays: 4,
    prospects: [
      { stage: "pending_approval", score: 8, reason: "Runs a 12-person plumbing and heating firm. Owner title confirmed on the profile.", person: trade("Impianti Prova Srl", "Owner") },
      { stage: "pending_approval", score: 7, reason: "Sole-trader electrician just outside Milan. Fits the trades brief; very small company.", person: trade("Elettro Demo", "Electrician and owner", "Monza, Italy", "1 employee") },
      { stage: "pending_approval", score: 4, reason: "Sales role at a 300-person construction company. Your brief excludes large firms.", person: trade("Edilizia Campione SpA", "Sales director", "Milan, Italy", "201-500 employees") },
      { stage: "needs_review", score: 7, reason: "Owner of a small building firm.", reviewReason: "LinkedIn showed a page the app does not recognise (profile_view)", person: trade("Costruzioni Esempio", "Owner") },
      { stage: "scored", score: 5, reason: "Employee, not an owner.", person: trade("Termoidraulica Test", "Technician") },
      { stage: "scored", score: 4, reason: "Large company.", person: trade("Gruppo Edile Modello", "Project manager", "Milan, Italy", "501-1000 employees") },
      { stage: "scored", score: 6, reason: "Owner, but the firm is outside the area.", person: trade("Idraulica Finta", "Owner", "Bergamo, Italy") },
      { stage: "scored", score: 3, reason: "Student.", person: trade("Politecnico Demo", "Student") },
      { stage: "found", person: trade("Elettricisti Prova", "Founder") },
      { stage: "found", person: trade("Serramenti Esempio", "Owner") },
    ],
  },
  {
    name: "Restaurants, Naples",
    status: "paused",
    brief: "Owners of independent restaurants and pizzerias in Naples.",
    inviteNote: "Hi {{first_name}}, I work with restaurants in Naples. Happy to connect.",
    firstMessage: "Thanks for connecting, {{first_name}}. How are bookings at {{company}} this season?",
    followUp: "Hi {{first_name}}, any thoughts on my last message?",
    ageDays: 30,
    prospects: [
      { stage: "approved", score: 8, reason: "Owner of a pizzeria.", person: food("Pizzeria Esempio", "Owner") },
      { stage: "invited", score: 8, reason: "Owner of a trattoria.", person: food("Trattoria Prova", "Owner") },
      { stage: "invited", score: 7, reason: "Chef and co-owner.", person: food("Osteria Demo", "Chef and co-owner") },
      { stage: "accepted", score: 9, reason: "Owner of two restaurants.", person: food("Ristorante Campione", "Owner") },
      { stage: "accepted", score: 7, reason: "Owner of a small restaurant.", person: food("Da Test", "Owner") },
      { stage: "message_sent", score: 8, reason: "Owner of a seafood restaurant.", person: food("Mare Finto", "Owner", "Pozzuoli, Italy") },
      { stage: "message_sent", score: 7, reason: "Owner of a pizzeria.", person: food("Pizzeria Modello", "Owner") },
      { stage: "completed", score: 8, reason: "Owner of a restaurant.", person: food("Ristorante Esempio", "Owner") },
      { stage: "withdrawn", score: 7, reason: "Owner of a café.", person: food("Caffè Prova", "Owner") },
      { stage: "rejected", score: 2, reason: "Food blogger, not an owner.", person: food("Blog Demo", "Writer") },
    ],
  },
  {
    name: "Architects, Turin",
    status: "finding",
    brief: "Founders and partners of small architecture studios in Turin. Not large engineering groups.",
    inviteNote: null,
    firstMessage: "Test first message for {{first_name}}.",
    followUp: "",
    ageDays: 2,
    prospects: ARCHITECTS,
  },
  {
    name: "Dentists, Bologna",
    status: "draft",
    brief: "",
    inviteNote: null,
    firstMessage: "",
    followUp: "",
    ageDays: 1,
    prospects: [],
  },
];

const CAMPAIGN_SEARCH_URL = "https://www.linkedin.com/search/results/people/?keywords=idraulico%20titolare";

const REACHED: Readonly<Record<ProspectStage, number>> = {
  found: 0,
  scored: 0,
  rejected: 0,
  pending_approval: 0,
  needs_review: 1,
  approved: 1,
  invited: 2,
  withdrawn: 2,
  accepted: 3,
  message_sent: 4,
  stopped: 5,
  follow_up_sent: 5,
  completed: 5,
};

function isEmpty(db: Conn): boolean {
  const campaignCount = db.select({ n: count() }).from(campaigns).get()?.n ?? 0;
  const peopleCount = db.select({ n: count() }).from(people).get()?.n ?? 0;
  return campaignCount === 0 && peopleCount === 0;
}

function fill(db: Conn, now: Date, withSafetyStop: boolean): { prospects: number; people: number } {
  const settings = getSettings(db);
  const dayStart = startOfDay(settings.timeZone, now).getTime();
  /** A moment today, `minutes` ago, never before the start of today in the app's time zone. */
  let tick = 0;
  const today = (minutes: number): Date => new Date(Math.max(dayStart + MINUTE + tick++ * 1000, now.getTime() - minutes * MINUTE));
  const ago = (ms: number) => new Date(now.getTime() - ms);

  let personNumber = 0;
  let keyNumber = 0;
  const ledger = (row: { type: ActionType; at: Date; prospectId?: number | null; campaignId?: number | null; screenshotPath?: string }) => {
    keyNumber += 1;
    db.insert(actions)
      .values({
        type: row.type,
        prospectId: row.prospectId ?? null,
        campaignId: row.campaignId ?? null,
        status: "done",
        idempotencyKey: `demo-${row.type}-${keyNumber}`,
        attempts: 1,
        startedAt: row.at,
        finishedAt: new Date(row.at.getTime() + 20_000),
        screenshotPath: row.screenshotPath ?? null,
      })
      .run();
  };
  const log = (at: Date, message: string, ids: { campaignId?: number; prospectId?: number } = {}, level: EventLevel = "info") =>
    db.insert(eventLog).values({ at, level, message, campaignId: ids.campaignId ?? null, prospectId: ids.prospectId ?? null }).run();

  const invitedToday: { prospectId: number; campaignId: number; name: string }[] = [];

  for (const [campaignIndex, seed] of CAMPAIGNS.entries()) {
    const created = ago(seed.ageDays * DAY);
    const campaignId = db
      .insert(campaigns)
      .values({
        name: seed.name,
        status: seed.status,
        pausedFrom: seed.status === "paused" ? "running" : null,
        discoverySource: campaignIndex === 1 ? "search" : "recommendations",
        sourceUrls: campaignIndex === 1 ? [CAMPAIGN_SEARCH_URL] : [],
        scoringBrief: seed.brief,
        inviteNote: seed.inviteNote,
        firstMessage: seed.firstMessage,
        followUp: seed.followUp,
        targetProspectCount: 100,
        createdAt: created,
        updatedAt: created,
      })
      .returning({ id: campaigns.id })
      .get().id;

    for (const [index, p] of seed.prospects.entries()) {
      personNumber += 1;
      const n = personNumber;
      const fullName = `Test Person ${n}`;
      const found = ago((seed.ageDays - Math.min(index, seed.ageDays - 1) * 0.5) * DAY);
      const personId = db
        .insert(people)
        .values({
          publicId: `test-person-${n}`,
          profileUrl: `https://www.linkedin.com/in/test-person-${n}/`,
          fullName,
          firstName: "Test",
          headline: `${p.person.title} at ${p.person.company}`,
          title: p.person.title,
          company: p.person.company,
          location: p.person.location,
          connectionDegree: 2,
          discoverySource: campaignIndex === 1 ? "search" : "recommendations",
          industryEvidence: p.score === undefined ? null : { value: p.person.industry, source: "profile", confidence: 0.8 },
          sizeEvidence: p.score !== undefined && p.score >= 6 ? { value: p.person.size, source: "company page", confidence: 0.6 } : null,
          firstSeenAt: found,
          profileViewedAt: p.score === undefined ? null : found,
        })
        .returning({ id: people.id })
        .get().id;

      const reached = REACHED[p.stage];
      const approvedAt = reached >= 1 ? new Date(found.getTime() + 2 * HOUR) : null;
      // The first few invited people of the running campaign were invited today; the rest earlier.
      const invitedTodayHere = campaignIndex === 0 && p.stage === "invited" && invitedToday.length < 4;
      const invitedAt = reached >= 2 ? (invitedTodayHere ? today(15 + invitedToday.length * 23) : new Date(found.getTime() + DAY)) : null;
      const acceptedAt = reached >= 3 && p.stage !== "withdrawn" && invitedAt !== null ? new Date(invitedAt.getTime() + 30 * HOUR) : null;
      const messagedAt = reached >= 4 && acceptedAt !== null ? new Date(acceptedAt.getTime() + 26 * HOUR) : null;
      const followUpAt = p.stage === "follow_up_sent" || p.stage === "completed" ? (messagedAt === null ? null : new Date(messagedAt.getTime() + 40 * HOUR)) : null;
      const repliedAt = p.stage === "stopped" && messagedAt !== null ? new Date(messagedAt.getTime() + 5 * HOUR) : null;
      const closedAt =
        p.stage === "rejected"
          ? new Date(found.getTime() + HOUR)
          : p.stage === "withdrawn"
            ? ago(DAY)
            : (repliedAt ?? (p.stage === "completed" ? followUpAt : null));
      const fill = (text: string | null) =>
        text === null || text === "" ? null : text.replaceAll("{{first_name}}", "Test").replaceAll("{{company}}", p.person.company);

      const prospectId = db
        .insert(prospects)
        .values({
          campaignId,
          personId,
          stage: p.stage,
          cardScore: p.score === undefined ? null : Math.max(0, p.score - 1),
          score: p.score ?? null,
          scoreReason: p.reason ?? null,
          stopReason: p.stage === "stopped" ? "replied" : null,
          reviewReason: p.reviewReason ?? null,
          inviteNoteSent: invitedAt === null ? null : fill(seed.inviteNote),
          firstMessageSent: messagedAt === null ? null : fill(seed.firstMessage),
          followUpSent: followUpAt === null ? null : fill(seed.followUp),
          foundAt: found,
          approvedAt,
          invitedAt,
          acceptanceObservedAt: acceptedAt,
          firstMessageSentAt: messagedAt,
          followUpSentAt: followUpAt,
          replyDetectedAt: repliedAt,
          closedAt,
        })
        .returning({ id: prospects.id })
        .get().id;

      if (invitedTodayHere && invitedAt !== null) {
        invitedToday.push({ prospectId, campaignId, name: fullName });
        ledger({ type: "invite", at: invitedAt, prospectId, campaignId });
        log(invitedAt, `Sent an invite to ${fullName}`, { campaignId, prospectId });
      }
      if (p.stage === "needs_review" && p.reviewReason !== undefined) {
        const heldAt = today(70 + index);
        const screenshotPath = campaignIndex === 1 ? `screenshots/demo-unrecognised-page-${n}.png` : undefined;
        ledger({ type: campaignIndex === 1 ? "profile_view" : "invite", at: heldAt, prospectId, campaignId, ...(screenshotPath === undefined ? {} : { screenshotPath }) });
        log(heldAt, `${fullName} needs review: ${p.reviewReason}`, { campaignId, prospectId }, "warning");
      }
    }
  }

  // Earlier invites on three working days, so the warm-up allowance has grown past its start.
  for (const daysBack of [1, 2, 3]) for (let i = 0; i < 4; i += 1) ledger({ type: "invite", at: ago(daysBack * DAY + i * 20 * MINUTE) });

  // Today's use of the account-wide budgets: invites above, plus the rest here.
  for (let i = 0; i < 2; i += 1) ledger({ type: "invite", at: today(130 + i * 9) });
  for (let i = 0; i < 4; i += 1) ledger({ type: "message", at: today(8 + i * 31) });
  for (let i = 0; i < 18; i += 1) ledger({ type: "profile_view", at: today(5 + i * 7) });
  for (let i = 0; i < 10; i += 1) ledger({ type: "recommendation_page", at: today(150 + i * 4) });
  ledger({ type: "withdraw", at: today(160) });

  const [hotels, trades, restaurants, architects] = [1, 2, 3, 4];
  // LinkedIn's monthly search limit holds the search campaign; the paused one has nobody left to find.
  db.insert(discoveryRuns)
    .values({ campaignId: trades, source: "search", sourceUrl: CAMPAIGN_SEARCH_URL, pausedUntil: startOfNextMonth(settings.timeZone, now), createdAt: ago(4 * DAY), updatedAt: ago(DAY) })
    .run();
  db.insert(discoveryRuns)
    .values({ campaignId: restaurants, source: "recommendations", sourceUrl: null, exhausted: true, createdAt: ago(30 * DAY), updatedAt: ago(3 * DAY) })
    .run();
  log(today(200), "Found 30 people in your recommendations", { campaignId: architects });
  log(today(185), "Scored 18 people from their cards; 10 were below the open-profile threshold", { campaignId: architects });
  log(today(190), "Discovery paused: the daily limit of 10 discovery pages is reached. It resumes on the next working day.", { campaignId: trades }, "warning");
  log(today(140), "Withdrew the invite to Test Person 39 after 21 days");
  log(today(95), "Test Person 14 accepted your invite", { campaignId: hotels });
  log(today(40), "Sent the first message to Test Person 16", { campaignId: hotels });
  log(today(25), "Viewed the profile of Test Person 22", { campaignId: trades });
  log(ago(2 * DAY), "Campaign Restaurants, Naples paused by you", { campaignId: restaurants });

  if (withSafetyStop) {
    const raisedAt = today(4);
    db.insert(safetyStops)
      .values({ reason: "checkpoint", detail: "It appeared while the app was opening a profile.", raisedAt })
      .run();
    log(raisedAt, "Safety stop: LinkedIn is asking for a security check. All LinkedIn activity is stopped until you resume.", {}, "error");
  }

  return { prospects: CAMPAIGNS.reduce((sum, c) => sum + c.prospects.length, 0), people: personNumber };
}

/** A grey placeholder image, so the demo's needs-review card has a screenshot to show. */
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mO8du3afwAH7gM3WqEo1QAAAABJRU5ErkJggg==",
  "base64",
);

function main(): number {
  const problem = scratchDataDirProblem(process.env);
  if (problem !== null) {
    process.stderr.write(`Refusing to seed: ${problem}. The demo data goes only into a scratch folder: set LINKEDIN_OUTREACH_DATA_DIR to one.\n`);
    return 1;
  }
  const paths = dataPaths();
  ensureDataDir(paths);
  const opened = openDb(paths.db, { durable: false });
  try {
    if (!isEmpty(opened.db)) {
      process.stderr.write(
        `Refusing to seed: the database at ${paths.db} already holds campaigns or people. The demo data goes only into an empty data directory (set LINKEDIN_OUTREACH_DATA_DIR to a new folder).\n`,
      );
      return 1;
    }
    const result = opened.db.transaction((tx) => fill(tx, new Date(), flags["safety-stop"]));
    for (const row of opened.sqlite.prepare("SELECT screenshot_path AS p FROM actions WHERE screenshot_path IS NOT NULL").all() as { p: string }[]) {
      writeFileSync(join(paths.screenshots, basename(row.p)), PLACEHOLDER_PNG, { mode: 0o600 });
    }
    process.stdout.write(
      `Seeded ${paths.db}: ${CAMPAIGNS.length} campaigns, ${result.people} people, ${result.prospects} prospects${flags["safety-stop"] ? ", an active safety stop" : ""}.\n`,
    );
    return 0;
  } finally {
    opened.close();
  }
}

process.exitCode = main();
