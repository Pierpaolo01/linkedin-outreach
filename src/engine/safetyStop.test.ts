import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safetyStops } from "../db/schema";
import { activeSafetyStop, raiseSafetyStop, resumeSafetyStop } from "./safetyStop";
import { createKit, events, HOUR, type Kit } from "./testKit";

let kit: Kit;
beforeEach(() => {
  kit = createKit();
});
afterEach(() => kit.close());

describe("safety stops", () => {
  it("none is active on a new install, and resume then reports false", () => {
    expect(activeSafetyStop(kit.db)).toBeNull();
    expect(resumeSafetyStop(kit.db, kit.clock.now())).toBe(false);
  });

  it("a raised stop is active with its reason, detail and screenshot, and is logged", () => {
    const now = kit.clock.now();
    raiseSafetyStop(kit.db, { reason: "checkpoint", detail: "security check", screenshotPath: "/tmp/x.png" }, now);
    const stop = activeSafetyStop(kit.db);
    expect(stop).toMatchObject({ reason: "checkpoint", detail: "security check", screenshotPath: "/tmp/x.png", raisedAt: now, resumedAt: null });
    expect(events(kit).some((message) => message.includes("Safety stop") && message.includes("checkpoint"))).toBe(true);
  });

  it("raising while one is active adds no second active row", () => {
    const now = kit.clock.now();
    raiseSafetyStop(kit.db, { reason: "logged_out" }, now);
    raiseSafetyStop(kit.db, { reason: "checkpoint" }, now);
    expect(kit.db.select().from(safetyStops).all()).toHaveLength(1);
    expect(activeSafetyStop(kit.db)?.reason).toBe("logged_out");
  });

  it("a later invite block raised during an active stop extends that stop's block", () => {
    const now = kit.clock.now();
    raiseSafetyStop(kit.db, { reason: "logged_out" }, now);
    const until = new Date(now.getTime() + 7 * 24 * HOUR);
    raiseSafetyStop(kit.db, { reason: "limit_hit", invitesBlockedUntil: until }, now);
    expect(activeSafetyStop(kit.db)?.invitesBlockedUntil).toEqual(until);
  });

  it("resume lifts the stop; a new one can then be raised", () => {
    const now = kit.clock.now();
    raiseSafetyStop(kit.db, { reason: "restricted" }, now);
    expect(resumeSafetyStop(kit.db, new Date(now.getTime() + HOUR))).toBe(true);
    expect(activeSafetyStop(kit.db)).toBeNull();
    raiseSafetyStop(kit.db, { reason: "unexpected_pages" }, new Date(now.getTime() + 2 * HOUR));
    expect(activeSafetyStop(kit.db)?.reason).toBe("unexpected_pages");
    expect(kit.db.select().from(safetyStops).all()).toHaveLength(2);
  });
});
