/** Tests on saved pages and invented dialogs only: the write operations are NOT VERIFIED ON THE LIVE SITE. */
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Checkpoint, LimitHit, LoggedOut, Restricted } from "../errors";
import { createWriteDriver } from "./driver";
import { scriptedPage } from "./scriptedPage";
import { CONNECT_PROFILE, fixture, overlay, PROFILE_PERSON, PROFILE_URL } from "./testPages";

const NOW = new Date("2026-11-12T10:00:00Z");
const GUARD = { notAfter: new Date("2026-11-12T17:00:00Z") };

type Options = Parameters<typeof scriptedPage>[0];

function driverOn(route: (url: string) => { url: string; html: string }, react?: Options["react"], hover?: Options["hover"]) {
  const controls = scriptedPage({ now: NOW, route, ...(react === undefined ? {} : { react }), ...(hover === undefined ? {} : { hover }) });
  const paces: string[] = [];
  const screenshotsDir = mkdtempSync(join(tmpdir(), "write-"));
  const driver = createWriteDriver({
    page: controls.page,
    pace: async () => {
      paces.push("pace");
    },
    health: { screenshotsDir },
    timeoutMs: 1_000,
  });
  return { driver, events: controls.events, paces, screenshotsDir };
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

  describe("when a page action fails because LinkedIn swapped the page", () => {
    // What Playwright throws when the control it was hovering went away with the page.
    const failure = () => new Error("locator.hover: Timeout 10000ms exceeded");
    const profile = fixture(CONNECT_PROFILE);

    it.each([
      ["a checkpoint", Checkpoint, checkpoint()],
      ["a login wall", LoggedOut, { url: "https://www.linkedin.com/authwall?trk=x", html: "<html></html>" }],
      ["a restriction", Restricted, { url: PROFILE_URL, html: fixture("session/synthetic-restricted-en.html") }],
    ] as const)("throws %s's typed error, with the page saved, and refuses every later write without loading a page", async (_case, Kind, shown) => {
      const { driver, events } = driverOn(
        (url) => ({ url, html: profile }),
        undefined,
        (_hovered, c) => {
          c.show(shown.html, shown.url);
          throw failure();
        },
      );

      const first = await driver.sendInvite(PROFILE_PERSON, null, GUARD).catch((e: unknown) => e);
      expect(first).toBeInstanceOf(Kind);
      expect((first as InstanceType<typeof Kind>).artifacts?.html).toBeDefined();
      const before = events.length;

      await expect(driver.sendMessage(PROFILE_PERSON, "TEST", { ...GUARD, messageCount: 0 })).rejects.toBe(first);
      await expect(driver.withdrawInvite(PROFILE_PERSON, GUARD)).rejects.toBe(first);
      expect(events).toHaveLength(before);
    });

    it("on a page that is still healthy, saves the page and lets the error through, and the next write goes ahead", async () => {
      const thrown = failure();
      const { driver, events, screenshotsDir } = driverOn(
        (url) => ({ url, html: profile }),
        undefined,
        () => {
          throw thrown;
        },
      );

      await expect(driver.sendInvite(PROFILE_PERSON, null, GUARD)).rejects.toBe(thrown);
      expect(readdirSync(screenshotsDir).some((file) => file.endsWith(".html"))).toBe(true);
      const before = events.length;

      await expect(driver.sendInvite(PROFILE_PERSON, null, GUARD)).rejects.toBe(thrown);
      expect(events.length).toBeGreaterThan(before);
    });
  });
});
