/** Tests on saved pages and invented dialogs only: the write operations are NOT VERIFIED ON THE LIVE SITE. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Checkpoint, LimitHit } from "../errors";
import { createWriteDriver } from "./driver";
import { scriptedPage } from "./scriptedPage";
import { CONNECT_PROFILE, fixture, overlay, PROFILE_PERSON } from "./testPages";

const NOW = new Date("2026-11-12T10:00:00Z");
const GUARD = { notAfter: new Date("2026-11-12T17:00:00Z") };

function driverOn(route: (url: string) => { url: string; html: string }, react?: Parameters<typeof scriptedPage>[0]["react"]) {
  const controls = scriptedPage({ now: NOW, route, ...(react === undefined ? {} : { react }) });
  const paces: string[] = [];
  const driver = createWriteDriver({
    page: controls.page,
    pace: async () => {
      paces.push("pace");
    },
    health: { screenshotsDir: mkdtempSync(join(tmpdir(), "write-")) },
    timeoutMs: 1_000,
  });
  return { driver, events: controls.events, paces };
}

const checkpoint = () => ({ url: "https://www.linkedin.com/checkpoint/challenge/x", html: fixture("session/synthetic-checkpoint-challenge-en.html") });

describe("createWriteDriver", () => {
  it("paces before each page load", async () => {
    const { driver, paces } = driverOn((url) => ({ url, html: fixture("invitations/sent-en.html") }));

    await driver.withdrawInvite({ publicId: "person-9", memberId: "ACoAAnine" }, GUARD);
    expect(paces).toEqual(["pace"]);
  });

  it("refuses every write after a checkpoint, with the same error and without loading a page", async () => {
    const { driver, events } = driverOn(checkpoint);
    const first = await driver.sendInvite(PROFILE_PERSON, null, GUARD).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(Checkpoint);
    const loads = events.length;

    await expect(driver.sendMessage(PROFILE_PERSON, "TEST", { ...GUARD, messageCount: 0 })).rejects.toBe(first);
    await expect(driver.withdrawInvite(PROFILE_PERSON, GUARD)).rejects.toBe(first);
    expect(events).toHaveLength(loads);
  });

  it("refuses every write after LinkedIn's invitation limit", async () => {
    const profile = fixture(CONNECT_PROFILE);
    const { driver, events } = driverOn(
      (url) => ({ url, html: profile }),
      (event, c) => {
        if (event.kind === "click") c.show(overlay(profile, "synthetic-invite-limit-en.html"));
        if (event.kind === "dismiss") c.show(profile);
      },
    );
    const first = await driver.sendInvite(PROFILE_PERSON, null, GUARD).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(LimitHit);
    const before = events.length;

    await expect(driver.sendInvite(PROFILE_PERSON, null, GUARD)).rejects.toBe(first);
    expect(events).toHaveLength(before);
  });
});
