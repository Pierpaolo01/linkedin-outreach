/**
 * Test helpers for the campaign and API tests: a real SQLite file in a temp directory and a few
 * seeding functions. Invented people only. Not used by the app.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../db/index";
import { campaigns, people, prospects, type ProspectStage } from "../db/schema";

export interface TestDb {
  readonly db: Db;
  readonly dir: string;
  close(): void;
}

export function openTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), "lo-campaigns-"));
  const opened = openDb(join(dir, "app.db"), { durable: false });
  return {
    db: opened.db,
    dir,
    close: () => {
      opened.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const T0 = new Date("2026-11-16T09:00:00Z");

/** A campaign ready to start: every check before start passes. */
export const READY_CAMPAIGN = {
  name: "Test campaign",
  discoverySource: "search",
  sourceUrls: ["https://www.linkedin.com/search/results/people/?keywords=founder"],
  scoringBrief: "Founders of small manufacturing companies",
  inviteNote: "Hi {{first_name}}, I work with companies like {{company}}.",
  firstMessage: "Thanks for connecting, {{first_name}}.",
  followUp: "Any thoughts, {{first_name}}?",
} as const satisfies Partial<typeof campaigns.$inferInsert>;

export function seedCampaign(db: Db, values: Partial<typeof campaigns.$inferInsert> = {}): number {
  const row = db
    .insert(campaigns)
    .values({ ...READY_CAMPAIGN, sourceUrls: [...READY_CAMPAIGN.sourceUrls], createdAt: T0, updatedAt: T0, ...values })
    .returning({ id: campaigns.id })
    .get();
  return row.id;
}

/** "Test Person n" at "Example Company n". */
export function seedPerson(db: Db, n: number, values: Partial<typeof people.$inferInsert> = {}): number {
  const row = db
    .insert(people)
    .values({
      publicId: `test-person-${n}`,
      profileUrl: `https://www.linkedin.com/in/test-person-${n}/`,
      fullName: `Test Person ${n}`,
      firstName: "Test",
      headline: `Founder at Example Company ${n}`,
      title: "Founder",
      company: `Example Company ${n}`,
      location: "Milan, Italy",
      firstSeenAt: T0,
      ...values,
    })
    .returning({ id: people.id })
    .get();
  return row.id;
}

export function seedProspect(
  db: Db,
  campaignId: number,
  personId: number,
  stage: ProspectStage,
  values: Partial<typeof prospects.$inferInsert> = {},
): number {
  const row = db
    .insert(prospects)
    .values({ campaignId, personId, stage, foundAt: T0, score: 8, scoreReason: "Owns a small manufacturer", ...values })
    .returning({ id: prospects.id })
    .get();
  return row.id;
}

/** A new person and a prospect for them in `campaignId`. */
export function seedPersonProspect(
  db: Db,
  campaignId: number,
  n: number,
  stage: ProspectStage,
  values: Partial<typeof prospects.$inferInsert> = {},
): { personId: number; prospectId: number } {
  const personId = seedPerson(db, n);
  return { personId, prospectId: seedProspect(db, campaignId, personId, stage, values) };
}
