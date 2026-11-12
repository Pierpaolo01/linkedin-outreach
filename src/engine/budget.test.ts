import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSettings, type Settings, type SettingsPatch } from "../config/settings";
import { openDb, type OpenedDb } from "../db/index";
import { ACTION_STATUSES, actions, safetyStops, type ActionStatus, type ActionType } from "../db/schema";
import { checkBudget, inviteAllowance, usageToday } from "./budget";

/**
 * Times are Europe/Rome (CET, UTC+1 in November). `now` is Wednesday 11 November 2026, 10:00 local.
 * Local midnight that starts the day is 2026-11-10T23:00Z; the week started Monday 9 November,
 * 00:00 local = 2026-11-08T23:00Z. The working window is Mon–Fri 09:00–18:00 local (08:00–17:00Z).
 */
const now = new Date("2026-11-11T09:00:00Z");
const TOMORROW_0900 = new Date("2026-11-12T08:00:00Z");

let dir: string;
let opened: OpenedDb;
let keySeq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lo-budget-"));
  opened = openDb(join(dir, "app.db"));
});

afterEach(() => {
  opened.close();
  rmSync(dir, { recursive: true, force: true });
});

function settingsWith(patch: SettingsPatch = {}): Settings {
  return setSettings(opened.db, patch, now);
}

/** Adds ledger rows; `startedAt: null` is a row never claimed. */
function addRows(
  type: ActionType,
  startedAt: string | null,
  { count = 1, status = "done" }: { count?: number; status?: ActionStatus } = {},
): void {
  for (let i = 0; i < count; i++) {
    keySeq += 1;
    opened.db
      .insert(actions)
      .values({
        type,
        status,
        idempotencyKey: `test:${keySeq}`,
        startedAt: startedAt === null ? null : new Date(startedAt),
      })
      .run();
  }
}

describe("checkBudget, day budgets", () => {
  it.each([
    { kind: "message", types: ["message"], limitKey: "messagesPerDay" },
    { kind: "profile_view", types: ["profile_view"], limitKey: "profileViewsPerDay" },
    { kind: "discovery_page", types: ["search_page", "recommendation_page"], limitKey: "discoveryPagesPerDay" },
    { kind: "withdraw", types: ["withdraw"], limitKey: "withdrawalsPerDay" },
  ] as const)("counts $types against limits.$limitKey for $kind", ({ kind, types, limitKey }) => {
    const settings = settingsWith({ limits: { [limitKey]: 3 } });
    // Ledger types of other budgets never count.
    addRows("thread_check", "2026-11-11T08:30:00Z", { count: 5 });
    addRows(kind === "message" ? "invite" : "message", "2026-11-11T08:30:00Z", { count: 5 });
    const [first, second = first] = types;
    addRows(first, "2026-11-11T08:00:00Z");
    addRows(second, "2026-11-11T08:10:00Z");

    expect(checkBudget(opened.db, settings, kind, now)).toEqual({
      allowed: true,
      reason: "ok",
      used: 2,
      limit: 3,
      resumesAt: null,
    });

    addRows(first, "2026-11-11T08:20:00Z");
    expect(checkBudget(opened.db, settings, kind, now)).toEqual({
      allowed: false,
      reason: "day_limit",
      used: 3,
      limit: 3,
      resumesAt: TOMORROW_0900,
    });
  });

  it("counts a row from local midnight on, not one a millisecond before", () => {
    const settings = settingsWith({ limits: { messagesPerDay: 10 } });
    addRows("message", "2026-11-10T22:59:59.999Z"); // 10 Nov, 23:59:59.999 local
    expect(checkBudget(opened.db, settings, "message", now).used).toBe(0);

    addRows("message", "2026-11-10T23:00:00.000Z"); // 11 Nov, 00:00 local
    expect(checkBudget(opened.db, settings, "message", now).used).toBe(1);
  });

  it("counts claimed rows of every status, including one planned again after a reconcile", () => {
    const settings = settingsWith({ limits: { messagesPerDay: 10 } });
    for (const status of ACTION_STATUSES) addRows("message", "2026-11-11T08:00:00Z", { status });
    expect(checkBudget(opened.db, settings, "message", now).used).toBe(ACTION_STATUSES.length);
  });

  it("ignores rows that were never claimed", () => {
    const settings = settingsWith({ limits: { messagesPerDay: 10 } });
    addRows("message", null, { count: 4, status: "planned" });
    expect(checkBudget(opened.db, settings, "message", now).used).toBe(0);
  });

  it("never allows a budget whose limit is 0", () => {
    const settings = settingsWith({ limits: { withdrawalsPerDay: 0 } });
    expect(checkBudget(opened.db, settings, "withdraw", now)).toEqual({
      allowed: false,
      reason: "day_limit",
      used: 0,
      limit: 0,
      resumesAt: TOMORROW_0900,
    });
  });

  it("reads a limit lowered below today's usage as spent", () => {
    const settings = settingsWith({ limits: { profileViewsPerDay: 3 } });
    addRows("profile_view", "2026-11-11T08:00:00Z", { count: 5 });
    expect(checkBudget(opened.db, settings, "profile_view", now)).toMatchObject({
      allowed: false,
      reason: "day_limit",
      used: 5,
      limit: 3,
    });
  });

  it("resumes on the next working day when tomorrow is not one", () => {
    const friday = new Date("2026-11-13T15:00:00Z");
    const settings = settingsWith({ limits: { messagesPerDay: 1 } });
    addRows("message", "2026-11-13T09:00:00Z");
    expect(checkBudget(opened.db, settings, "message", friday).resumesAt).toEqual(new Date("2026-11-16T08:00:00Z"));
  });
});

describe("checkBudget, invite week", () => {
  it("counts the calendar week from Monday 00:00 local, not the Sunday before", () => {
    const settings = settingsWith({
      warmUp: { enabled: false },
      limits: { invitesPerDay: 15, invitesPerWeek: 2 },
    });
    addRows("invite", "2026-11-08T22:59:59.999Z"); // Sunday 8 Nov, 23:59:59.999 local
    addRows("invite", "2026-11-08T23:00:00.000Z"); // Monday 9 Nov, 00:00 local
    expect(checkBudget(opened.db, settings, "invite", now)).toMatchObject({ allowed: true, used: 0 });

    addRows("invite", "2026-11-10T10:00:00Z"); // Tuesday
    expect(checkBudget(opened.db, settings, "invite", now)).toEqual({
      allowed: false,
      reason: "week_limit",
      used: 0,
      limit: 15,
      resumesAt: new Date("2026-11-16T08:00:00Z"), // Monday 16 Nov, 09:00 local
    });
  });
});

describe("inviteAllowance, warm-up", () => {
  const warmUp = { enabled: true, invitesStartPerDay: 5, invitesIncreasePerDay: 2 };

  it("starts at invitesStartPerDay when no earlier day had an invite", () => {
    const settings = settingsWith({ warmUp, limits: { invitesPerDay: 15 } });
    addRows("invite", "2026-11-11T08:00:00Z", { count: 3 }); // today does not advance it
    expect(inviteAllowance(opened.db, settings, now)).toBe(5);
  });

  it("rises by invitesIncreasePerDay for each earlier local day with an invite", () => {
    const settings = settingsWith({ warmUp, limits: { invitesPerDay: 15 } });
    addRows("invite", "2026-11-06T10:00:00Z", { count: 4 }); // Friday 6 Nov
    addRows("invite", "2026-11-08T22:30:00Z"); // Sunday 8 Nov, 23:30 local
    addRows("invite", "2026-11-08T23:30:00Z"); // Monday 9 Nov, 00:30 local: same UTC date, another local day
    expect(inviteAllowance(opened.db, settings, now)).toBe(11);
  });

  it("stops at limits.invitesPerDay", () => {
    const settings = settingsWith({ warmUp, limits: { invitesPerDay: 15 } });
    for (let day = 1; day <= 10; day++) addRows("invite", `2026-10-${String(day).padStart(2, "0")}T10:00:00Z`);
    expect(inviteAllowance(opened.db, settings, now)).toBe(15);
  });

  it("does not advance over idle days", () => {
    const settings = settingsWith({ warmUp, limits: { invitesPerDay: 15 } });
    addRows("invite", "2026-10-01T10:00:00Z");
    addRows("invite", "2026-10-02T10:00:00Z");
    expect(inviteAllowance(opened.db, settings, now)).toBe(9);
  });

  it("advances only for an earlier day on which an invite went out", () => {
    const settings = settingsWith({ warmUp, limits: { invitesPerDay: 15 } });
    // A day of attempts that LinkedIn never received is not a day of inviting.
    addRows("invite", "2026-11-05T10:00:00Z", { status: "failed" });
    addRows("invite", "2026-11-06T10:00:00Z", { status: "unknown" });
    addRows("invite", "2026-11-09T10:00:00Z", { status: "planned" }); // claimed, found not sent, to be tried again
    addRows("invite", null, { count: 3, status: "planned" });
    expect(inviteAllowance(opened.db, settings, now)).toBe(5);
    addRows("invite", "2026-11-10T10:00:00Z", { status: "done" });
    expect(inviteAllowance(opened.db, settings, now)).toBe(7);
  });

  it("is limits.invitesPerDay when warm-up is off", () => {
    const settings = settingsWith({ warmUp: { enabled: false }, limits: { invitesPerDay: 12 } });
    expect(inviteAllowance(opened.db, settings, now)).toBe(12);
  });

  it("is the day limit checkBudget applies to invites", () => {
    const settings = settingsWith({ warmUp, limits: { invitesPerDay: 15, invitesPerWeek: 80 } });
    addRows("invite", "2026-11-11T08:00:00Z", { count: 4 });
    expect(checkBudget(opened.db, settings, "invite", now)).toMatchObject({ allowed: true, used: 4, limit: 5 });

    addRows("invite", "2026-11-11T08:30:00Z");
    expect(checkBudget(opened.db, settings, "invite", now)).toEqual({
      allowed: false,
      reason: "day_limit",
      used: 5,
      limit: 5,
      resumesAt: TOMORROW_0900,
    });
  });
});

describe("checkBudget, invites blocked after LinkedIn's invitation-limit message", () => {
  function addStop(invitesBlockedUntil: string, resumedAt: string | null = null): void {
    opened.db
      .insert(safetyStops)
      .values({
        reason: "limit_hit",
        raisedAt: new Date("2026-11-10T10:00:00Z"),
        resumedAt: resumedAt === null ? null : new Date(resumedAt),
        invitesBlockedUntil: new Date(invitesBlockedUntil),
      })
      .run();
  }

  it("blocks invites until the next working instant at or after the latest block", () => {
    const settings = settingsWith({ warmUp: { enabled: false } });
    addStop("2026-11-12T12:00:00Z");
    addStop("2026-11-14T12:00:00Z"); // Saturday 14 Nov
    expect(checkBudget(opened.db, settings, "invite", now)).toEqual({
      allowed: false,
      reason: "invites_blocked",
      used: 0,
      limit: 15,
      resumesAt: new Date("2026-11-16T08:00:00Z"), // Monday 16 Nov, 09:00 local
    });
  });

  it("keeps blocking once the safety stop is resumed", () => {
    const settings = settingsWith({ warmUp: { enabled: false } });
    addStop("2026-11-12T12:00:00Z", "2026-11-10T12:00:00Z");
    expect(checkBudget(opened.db, settings, "invite", now)).toMatchObject({
      allowed: false,
      reason: "invites_blocked",
      resumesAt: new Date("2026-11-12T12:00:00Z"),
    });
  });

  it("allows invites once the block has expired", () => {
    const settings = settingsWith({ warmUp: { enabled: false } });
    addStop("2026-11-04T12:00:00Z", "2026-11-04T12:00:00Z");
    addStop(now.toISOString()); // a block that ends exactly now is over
    expect(checkBudget(opened.db, settings, "invite", now)).toMatchObject({ allowed: true, reason: "ok" });
  });

  it("does not touch other budgets", () => {
    const settings = settingsWith({});
    addStop("2026-11-14T12:00:00Z");
    expect(checkBudget(opened.db, settings, "message", now)).toMatchObject({ allowed: true, reason: "ok" });
  });
});

describe("checkBudget, several reasons at once", () => {
  const spentToday = () => addRows("invite", "2026-11-11T08:00:00Z", { count: 15 });

  it("reports the block when it lasts beyond the day limit", () => {
    const settings = settingsWith({ warmUp: { enabled: false }, limits: { invitesPerDay: 15, invitesPerWeek: 80 } });
    spentToday();
    opened.db
      .insert(safetyStops)
      .values({ reason: "limit_hit", raisedAt: now, invitesBlockedUntil: new Date("2026-11-12T10:00:00Z") })
      .run();
    expect(checkBudget(opened.db, settings, "invite", now)).toMatchObject({
      reason: "invites_blocked",
      resumesAt: new Date("2026-11-12T10:00:00Z"),
    });
  });

  it("reports the day limit when it lasts beyond the block", () => {
    const settings = settingsWith({ warmUp: { enabled: false }, limits: { invitesPerDay: 15, invitesPerWeek: 80 } });
    spentToday();
    opened.db
      .insert(safetyStops)
      .values({ reason: "limit_hit", raisedAt: now, invitesBlockedUntil: new Date("2026-11-11T15:00:00Z") })
      .run();
    expect(checkBudget(opened.db, settings, "invite", now)).toMatchObject({
      reason: "day_limit",
      resumesAt: TOMORROW_0900,
    });
  });

  it("reports the week limit when it lasts beyond the day limit", () => {
    const settings = settingsWith({ warmUp: { enabled: false }, limits: { invitesPerDay: 15, invitesPerWeek: 15 } });
    spentToday();
    expect(checkBudget(opened.db, settings, "invite", now)).toMatchObject({
      reason: "week_limit",
      resumesAt: new Date("2026-11-16T08:00:00Z"),
    });
  });
});

describe("usageToday", () => {
  it("gives every budget's use and limit today, invites under warm-up", () => {
    const settings = settingsWith({
      warmUp: { enabled: true, invitesStartPerDay: 5, invitesIncreasePerDay: 2 },
      limits: {
        invitesPerDay: 15,
        invitesPerWeek: 80,
        messagesPerDay: 10,
        profileViewsPerDay: 40,
        discoveryPagesPerDay: 10,
        withdrawalsPerDay: 10,
      },
    });
    addRows("invite", "2026-11-10T10:00:00Z"); // yesterday: warm-up day 1
    addRows("invite", "2026-11-11T08:00:00Z", { count: 2 });
    addRows("message", "2026-11-11T08:00:00Z", { count: 3, status: "unknown" });
    addRows("profile_view", "2026-11-11T08:00:00Z", { count: 4 });
    addRows("search_page", "2026-11-11T08:00:00Z");
    addRows("recommendation_page", "2026-11-11T08:00:00Z");
    addRows("message", null, { status: "planned" });

    expect(usageToday(opened.db, settings, now)).toEqual({
      invite: { used: 2, limit: 7 },
      message: { used: 3, limit: 10 },
      profile_view: { used: 4, limit: 40 },
      discovery_page: { used: 2, limit: 10 },
      withdraw: { used: 0, limit: 10 },
    });
  });
});
