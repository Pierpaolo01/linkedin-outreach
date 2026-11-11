import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type OpenedDb } from "./index";
import { actions, campaigns, people, prospects, sessionState } from "./schema";

let dir: string;
let opened: OpenedDb;
const now = new Date("2026-11-11T09:00:00Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lo-schema-"));
  opened = openDb(join(dir, "app.db"));
});

afterEach(() => {
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

function addPerson(publicId: string): number {
  const row = opened.db
    .insert(people)
    .values({
      publicId,
      profileUrl: `https://www.linkedin.com/in/${publicId}/`,
      fullName: "Test Person",
      firstSeenAt: now,
    })
    .returning({ id: people.id })
    .get();
  return row.id;
}

function addCampaign(name: string): number {
  const row = opened.db
    .insert(campaigns)
    .values({ name, discoverySource: "recommendations", createdAt: now, updatedAt: now })
    .returning({ id: campaigns.id })
    .get();
  return row.id;
}

describe("schema constraints", () => {
  it("stores a person once per public identifier", () => {
    addPerson("test-person-1");
    expect(() => addPerson("test-person-1")).toThrow(/UNIQUE constraint failed: people.public_id/);
  });

  it("allows one prospect per campaign and person, and the same person in another campaign", () => {
    const personId = addPerson("test-person-2");
    const first = addCampaign("Construction");
    const second = addCampaign("Hotels");
    const add = (campaignId: number) =>
      opened.db.insert(prospects).values({ campaignId, personId, foundAt: now }).run();

    add(first);
    expect(() => add(first)).toThrow(/UNIQUE constraint failed: prospects.campaign_id, prospects.person_id/);
    expect(() => add(second)).not.toThrow();
  });

  it("rejects a second action with the same idempotency key", () => {
    const add = () =>
      opened.db.insert(actions).values({ type: "invite", idempotencyKey: "invite:1", status: "planned" }).run();
    add();
    expect(() => add()).toThrow(/UNIQUE constraint failed: actions.idempotency_key/);
  });

  it("rejects a prospect pointing at a missing campaign", () => {
    const personId = addPerson("test-person-3");
    expect(() => opened.db.insert(prospects).values({ campaignId: 999, personId, foundAt: now }).run()).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it("keeps session_state to a single row", () => {
    opened.db.insert(sessionState).values({ id: 1 }).run();
    expect(() => opened.db.insert(sessionState).values({ id: 2 }).run()).toThrow(/CHECK constraint failed/);
  });

  it("reads timestamps back as the same UTC instant", () => {
    const id = addPerson("test-person-4");
    const row = opened.sqlite.prepare("SELECT first_seen_at AS t FROM people WHERE id = ?").get(id) as { t: number };
    expect(row.t).toBe(Date.UTC(2026, 10, 11, 9, 0, 0));
  });
});
