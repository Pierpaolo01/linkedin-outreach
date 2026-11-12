/**
 * NOT VERIFIED ON THE LIVE SITE. Built and tested against saved pages only; see
 * docs/research/write-operations.md for what must be checked before the first real send.
 *
 * The page interface the write operations act through (`WritePage`), and its implementation over
 * the dedicated window (`writePageFor`). The operations take the interface, so tests drive them
 * with a scripted stand-in and no browser.
 */
import type { Locator, Page } from "playwright";
import { humanDelay, randomInt, realSleep, type RandomSource, type Sleep } from "../human";
import type { InspectablePage } from "../pageHealth";
import { settle } from "../session";

/** The ARIA roles the operations look controls up by. */
export type Role = "button" | "link" | "textbox" | "menuitem";

/** Limits a lookup to the inside of the elements matching `css` (and, when given, holding a match of `has`). */
export interface Scope {
  readonly css: string;
  readonly has?: string;
}

/**
 * A control found the way a person finds it: by its role and its accessible name (aria-label, else
 * its text), inside a scope. `name` is tested against the name with whitespace collapsed; omitted,
 * any name matches.
 */
export interface Target {
  readonly roles: readonly Role[];
  readonly name?: RegExp;
  readonly within?: Scope;
}

/** What the write operations need from the dedicated window. Hidden elements never match a target. */
export interface WritePage extends InspectablePage {
  /** Navigates and returns once the page has settled. */
  load(url: string): Promise<void>;
  /** How many visible elements match. */
  count(target: Target): Promise<number>;
  /** Clicks the first visible match, as a person would. Throws when there is none. */
  click(target: Target): Promise<void>;
  /**
   * `click`, for a click that acts on LinkedIn: `refuse` runs after the hover and pause, immediately
   * before the click itself. When it returns a reason, nothing is clicked and the reason is returned;
   * undefined once clicked. The deadline, or a conversation that changed, during the pause still stops the click.
   */
  clickUnless<R>(target: Target, refuse: () => Promise<R | undefined>): Promise<R | undefined>;
  /** Types into the first visible match with human timing. A line break is Shift+Enter; Enter is never pressed. */
  type(target: Target, text: string): Promise<void>;
  /** Empties the first visible match (a text box). */
  clear(target: Target): Promise<void>;
  /** The text in the first visible match (a text box). */
  value(target: Target): Promise<string>;
  /** Presses Escape: closes an open menu or dialog without choosing anything. */
  dismiss(): Promise<void>;
  /** Reads the page's HTML until `check` returns a value, or `timeoutMs` passes (undefined). */
  waitFor<T>(check: (html: string) => T | undefined, timeoutMs: number): Promise<T | undefined>;
  /** The clock the deadline is read against. */
  now(): Date;
}

/** One key action of typing a text: a run of characters, or Shift+Enter for a line break. */
export type Keystroke = { readonly kind: "text"; readonly text: string } | { readonly kind: "line_break" };

/**
 * How a text is typed. Line breaks become Shift+Enter: in LinkedIn's message box Enter can be set to
 * send, and a text must never be sent by a key, only by clicking Send.
 * Not verified on the live site.
 */
export function keystrokesFor(text: string): Keystroke[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines.flatMap((line, index): Keystroke[] => [
    ...(index > 0 ? [{ kind: "line_break" } as const] : []),
    ...(line === "" ? [] : [{ kind: "text", text: line } as const]),
  ]);
}

export interface WritePageOptions {
  readonly random?: RandomSource;
  readonly sleep?: Sleep;
  /** How often `waitFor` reads the page. */
  readonly pollMs?: number;
}

const CLICK_TIMEOUT_MS = 10_000;

/**
 * NOT VERIFIED ON THE LIVE SITE. The dedicated window as a `WritePage`. Lookups use Playwright's
 * role locators, which skip hidden elements; a click hovers first and pauses like a person.
 */
export function writePageFor(page: Page, { random = Math.random, sleep = realSleep, pollMs = 500 }: WritePageOptions = {}): WritePage {
  const pause = (minMs: number, maxMs: number) => humanDelay({ minMs, maxMs, random, sleep });

  function locate(target: Target): Locator {
    const scope = target.within;
    const base = scope === undefined ? page : page.locator(scope.css, scope.has === undefined ? {} : { has: page.locator(scope.has) });
    const [first, ...rest] = target.roles.map((role) => base.getByRole(role, target.name === undefined ? {} : { name: target.name }));
    if (first === undefined) throw new RangeError("a target needs at least one role");
    return rest.reduce((all, next) => all.or(next), first).filter({ visible: true });
  }

  async function only(target: Target): Promise<Locator> {
    const found = locate(target);
    if ((await found.count()) === 0) throw new Error(`nothing on the page matches ${describeTarget(target)}`);
    return found.first();
  }

  /** Finds the first visible match, hovers it and pauses like a person before a click. */
  async function hovered(target: Target): Promise<Locator> {
    const control = await only(target);
    await control.hover({ timeout: CLICK_TIMEOUT_MS });
    await pause(250, 800);
    return control;
  }

  return {
    async load(url) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await settle(page);
      await pause(1_500, 3_000);
    },
    count: (target) => locate(target).count(),
    async click(target) {
      const control = await hovered(target);
      await control.click({ delay: randomInt({ min: 40, max: 120, random }), timeout: CLICK_TIMEOUT_MS });
    },
    async clickUnless(target, refuse) {
      const control = await hovered(target);
      // Last, after the pause: the laptop can sleep, or a reply land, while it lasts.
      const reason = await refuse();
      if (reason !== undefined) return reason;
      await control.click({ delay: randomInt({ min: 40, max: 120, random }), timeout: CLICK_TIMEOUT_MS });
      return undefined;
    },
    async type(target, text) {
      const box = await only(target);
      await box.click({ timeout: CLICK_TIMEOUT_MS });
      await pause(300, 900);
      for (const stroke of keystrokesFor(text)) {
        if (stroke.kind === "line_break") {
          await page.keyboard.press("Shift+Enter");
          await pause(150, 400);
          continue;
        }
        for (const char of stroke.text) {
          await page.keyboard.type(char);
          await pause(35, 140);
        }
      }
    },
    async clear(target) {
      const box = await only(target);
      await box.click({ timeout: CLICK_TIMEOUT_MS });
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("Backspace");
      await pause(200, 500);
    },
    async value(target) {
      const box = await only(target);
      return box.evaluate((el) =>
        el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value : el instanceof HTMLElement ? el.innerText : "",
      );
    },
    async dismiss() {
      await page.keyboard.press("Escape");
      await pause(300, 700);
    },
    async waitFor(check, timeoutMs) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const found = check(await page.content());
        if (found !== undefined) return found;
        if (Date.now() >= until) return undefined;
        await sleep(pollMs);
      }
    },
    now: () => new Date(),
    url: () => page.url(),
    content: () => page.content(),
    screenshot: (options) => page.screenshot(options),
  };
}

/** For error messages: "button or link named /^send$/i". Not verified on the live site. */
export function describeTarget(target: Target): string {
  const where = target.within === undefined ? "" : ` inside ${target.within.css}`;
  return `${target.roles.join(" or ")}${target.name === undefined ? "" : ` named ${String(target.name)}`}${where}`;
}
