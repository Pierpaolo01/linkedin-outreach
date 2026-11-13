/**
 * NOT VERIFIED ON THE LIVE SITE: this checks saved pages only.
 *
 * The locators of the write operations, run by real Chrome on saved pages, to prove Playwright
 * finds the Connect, Send and Withdraw controls in the saved markup the way `markup.ts` does.
 *
 * Safe by construction: a fresh, non-persistent browser context (never the app's dedicated
 * profile), every network request aborted, and each page put in with `setContent`, so there is no
 * navigation to any URL. Nothing here can reach LinkedIn.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { isChromeMissing } from "../browser";
import { hasOpenDialog } from "./common";
import { findAll, parseHtml } from "./markup";
import { writePageFor, type Target, type WritePage } from "./page";
import { sentRowOf, writeStructure, writeWordingFor } from "./selectors.write";
import { COMPOSE_EXISTING, CONNECT_PROFILE, fixture, overlay, SENT_PAGE } from "./testPages";

const en = writeWordingFor("en");
let browser: Browser | undefined;
let context: BrowserContext | undefined;
const requests: string[] = [];

beforeAll(async () => {
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch (error) {
    if (isChromeMissing(error)) return;
    throw error;
  }
  context = await browser.newContext();
  await context.route("**/*", async (route) => {
    requests.push(route.request().url());
    await route.abort();
  });
}, 60_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

async function show(html: string): Promise<{ page: Page; write: WritePage; saved: (target: Target) => number }> {
  if (context === undefined) throw new Error("no browser");
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: "domcontentloaded" });
  const root = parseHtml(html);
  return { page, write: writePageFor(page, { sleep: async () => undefined }), saved: (target) => findAll(root, target).length };
}

describe("write locators in real Chrome, offline", { timeout: 60_000 }, () => {
  it("find Connect and More in the saved profile's top card, and not the sticky header's Connect", async (ctx) => {
    if (context === undefined) ctx.skip();
    const { page, write, saved } = await show(fixture(CONNECT_PROFILE));
    const connect: Target = { roles: ["button", "link"], name: en.connect, within: writeStructure.topCard };
    const anywhere: Target = { roles: ["button", "link"], name: en.connect };
    const more: Target = { roles: ["button"], name: en.more, within: writeStructure.topCard };
    // The Dismiss buttons of the closed ad dialogs are hidden.
    const dismiss: Target = { roles: ["button"], name: /^dismiss$/i };

    expect(await write.count(connect)).toBe(2);
    expect(await write.count(anywhere)).toBeGreaterThan(2);
    expect(await write.count(more)).toBe(2);
    expect(await write.count(dismiss)).toBe(0);
    for (const target of [connect, anywhere, more, dismiss]) expect(await write.count(target)).toBe(saved(target));
    expect(page.url()).toBe("about:blank");
  });

  it("find the dialog's choices once a dialog is shown", async (ctx) => {
    if (context === undefined) ctx.skip();
    const { write, saved } = await show(overlay(fixture(CONNECT_PROFILE), "synthetic-invite-choose-en.html"));
    const addNote: Target = { roles: ["button"], name: en.addNote, within: writeStructure.dialog };
    const withoutNote: Target = { roles: ["button"], name: en.sendWithoutNote, within: writeStructure.dialog };

    expect(await write.count(addNote)).toBe(1);
    expect(await write.count(withoutNote)).toBe(1);
    expect(saved(addNote) + saved(withoutNote)).toBe(2);
  });

  it("find the message box and Send in the saved conversation, and type with Shift+Enter for a line break", async (ctx) => {
    if (context === undefined) ctx.skip();
    const { page, write, saved } = await show(fixture(COMPOSE_EXISTING));
    const box: Target = { roles: ["textbox"], within: writeStructure.messageForm };
    const send: Target = { roles: ["button"], name: en.sendMessage, within: writeStructure.messageForm };

    expect(await write.count(box)).toBe(1);
    expect(await write.count(send)).toBe(1);
    expect(saved(box) + saved(send)).toBe(2);

    await write.type(box, "TEST line one\nTEST line two");
    expect((await write.value(box)).replace(/\n+/g, "\n")).toBe("TEST line one\nTEST line two");
    await write.clear(box);
    expect((await write.value(box)).trim()).toBe("");
    expect(page.url()).toBe("about:blank");
  });

  it("find Withdraw on the person's row of the saved sent-invitations page", async (ctx) => {
    if (context === undefined) ctx.skip();
    const { write, saved } = await show(fixture(SENT_PAGE));
    const theirs: Target = { roles: ["button", "link"], name: en.withdraw, within: sentRowOf("person-1") };

    expect(await write.count(theirs)).toBe(1);
    expect(saved(theirs)).toBe(1);
    expect(await write.count({ roles: ["button", "link"], name: en.withdraw, within: sentRowOf("person-9") })).toBe(0);
  });

  it("run a click's last-moment check after the hover and pause, and click nothing when it refuses", async (ctx) => {
    if (context === undefined) ctx.skip();
    const { page } = await show('<html><body><button type="button" onclick="window.clicked = (window.clicked ?? 0) + 1">Send</button></body></html>');
    const steps: string[] = [];
    const write = writePageFor(page, { sleep: async () => void steps.push("pause") });
    const send: Target = { roles: ["button"], name: /^send$/i };

    const refused = await write.clickUnless(send, async () => {
      steps.push("check");
      return "expired" as const;
    });
    expect(refused).toBe("expired");
    expect(steps).toEqual(["pause", "check"]);
    expect(await page.evaluate(() => (window as { clicked?: number }).clicked ?? 0)).toBe(0);

    await expect(write.clickUnless(send, async () => undefined)).resolves.toBeUndefined();
    expect(await page.evaluate(() => (window as { clicked?: number }).clicked ?? 0)).toBe(1);
    expect(page.url()).toBe("about:blank");
  });

  it("sees a dialog LinkedIn draws inside a shadow root, as the live invite dialog is (2026-11-13)", async (ctx) => {
    if (context === undefined) ctx.skip();
    // The live page holds the invite dialog in an open shadow root under #interop-outlet, which
    // Playwright's page.content() leaves out.
    const { page, write } = await show(
      '<html lang="en"><body><main><h1>Profile</h1></main><div id="interop-outlet" data-testid="interop-shadowdom"></div></body></html>',
    );
    await page.evaluate(() => {
      const host = document.getElementById("interop-outlet");
      if (host === null) throw new Error("no host");
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML =
        '<div><dialog><h2>Add a note to your invitation?</h2><button>Add a note</button><button>Send without a note</button></dialog></div>';
      root.querySelector("dialog")?.showModal();
    });
    expect(hasOpenDialog(await page.content())).toBe(false);

    const html = await write.content();
    expect(hasOpenDialog(html)).toBe(true);
    const inDialog = (name: RegExp): Target => ({ roles: ["button"], name, within: writeStructure.dialog });
    expect(findAll(parseHtml(html), inDialog(en.addNote))).toHaveLength(1);
    expect(findAll(parseHtml(html), inDialog(en.sendWithoutNote))).toHaveLength(1);
    expect(await write.count(inDialog(en.addNote))).toBe(1);
    expect(await write.waitFor((shown) => (hasOpenDialog(shown) ? "seen" : undefined), 1_000)).toBe("seen");
    expect(html).toMatch(/^<html lang="en">/);
  });

  it("aborts every request a page makes", async (ctx) => {
    if (context === undefined) ctx.skip();
    const { page } = await show('<html><body><img src="https://blocked.invalid/probe.png"></body></html>');
    const failed = new Promise<string>((resolve) => page.on("requestfailed", (request) => resolve(request.url())));

    await page.evaluate(() => fetch("https://blocked.invalid/probe.json").catch(() => undefined));
    expect(await failed).toMatch(/^https:\/\/blocked\.invalid\//);
    expect(requests).toContain("https://blocked.invalid/probe.json");
  });
});
