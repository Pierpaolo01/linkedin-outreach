/**
 * NOT VERIFIED ON THE LIVE SITE: this checks saved pages only.
 *
 * Test stand-in for the dedicated window: a `WritePage` that shows saved HTML and records every
 * action. Clicks and typing are resolved against the HTML shown at that moment (with the same
 * role-and-name rules as `markup.ts`), so a click on a control the page does not have fails as it
 * would in the browser. What a click does is up to the test (`react`); a wait that finds nothing
 * moves the clock on by its timeout, as a real wait would.
 *
 * Used by the tests only. Never touches a browser or the network.
 */
import { accessibleName, fieldText, findAll, parseHtml } from "./markup";
import { describeTarget, type Target, type WritePage } from "./page";

export type ScriptedEvent =
  | { readonly kind: "load"; readonly url: string }
  /** `name`: the accessible name of the element clicked. */
  | { readonly kind: "click"; readonly target: Target; readonly name: string }
  | { readonly kind: "type"; readonly target: Target; readonly text: string }
  | { readonly kind: "clear"; readonly target: Target }
  | { readonly kind: "dismiss" }
  | { readonly kind: "timeout"; readonly ms: number };

export interface Shown {
  readonly url: string;
  readonly html: string;
}

export interface ScriptedControls {
  readonly page: WritePage;
  /** Every action, in order. */
  readonly events: ScriptedEvent[];
  /** Shows another page (the URL stays unless given). Typed text is kept: the box is still there. */
  show(html: string, url?: string): void;
  /** What is shown now. */
  shown(): Shown;
  /** Moves the clock on. */
  advance(ms: number): void;
  /** The text a box holds now, as typed or cleared, else as the HTML holds it. */
  typed(target: Target): string | undefined;
}

export interface ScriptedOptions {
  readonly now: Date;
  /** What a load of `url` shows. */
  readonly route: (url: string) => Shown;
  /** Called after every action, to make the page respond. */
  readonly react?: (event: ScriptedEvent, controls: ScriptedControls) => void;
}

/** A key that identifies a target, regexes included. Not verified on the live site. */
function keyOf(target: Target): string {
  return JSON.stringify({ ...target, name: target.name === undefined ? null : String(target.name) });
}

/** Not verified on the live site. */
export function scriptedPage({ now, route, react }: ScriptedOptions): ScriptedControls {
  let clock = now.getTime();
  let current: Shown = { url: "about:blank", html: "<html></html>" };
  const values = new Map<string, string>();
  const events: ScriptedEvent[] = [];

  function first(target: Target) {
    const root = parseHtml(current.html);
    const [el] = findAll(root, target);
    if (el === undefined) throw new Error(`scripted page: nothing matches ${describeTarget(target)}`);
    return { el, name: accessibleName(el, root) };
  }

  function record(event: ScriptedEvent): void {
    events.push(event);
    react?.(event, controls);
  }

  const page: WritePage = {
    async load(url) {
      current = route(url);
      values.clear();
      record({ kind: "load", url });
    },
    async count(target) {
      return findAll(parseHtml(current.html), target).length;
    },
    async click(target) {
      record({ kind: "click", target, name: first(target).name });
    },
    async type(target, text) {
      const key = keyOf(target);
      const before = values.get(key) ?? fieldText(first(target).el);
      values.set(key, before + text);
      record({ kind: "type", target, text });
    },
    async clear(target) {
      first(target);
      values.set(keyOf(target), "");
      record({ kind: "clear", target });
    },
    async value(target) {
      return values.get(keyOf(target)) ?? fieldText(first(target).el);
    },
    async dismiss() {
      record({ kind: "dismiss" });
    },
    async waitFor(check, timeoutMs) {
      const found = check(current.html);
      if (found !== undefined) return found;
      clock += timeoutMs;
      record({ kind: "timeout", ms: timeoutMs });
      return check(current.html);
    },
    now: () => new Date(clock),
    url: () => current.url,
    content: async () => current.html,
    screenshot: async () => Buffer.from(""),
  };

  const controls: ScriptedControls = {
    page,
    events,
    show(html, url) {
      current = { url: url ?? current.url, html };
    },
    shown: () => current,
    advance(ms) {
      clock += ms;
    },
    typed: (target) => values.get(keyOf(target)),
  };
  return controls;
}
