/**
 * NOT VERIFIED ON THE LIVE SITE.
 *
 * Finds controls and open dialogs in saved HTML the way `writePageFor` finds them in the browser:
 * by ARIA role and accessible name, skipping hidden elements. The write operations use it to read
 * dialogs; the scripted stand-in used by the tests uses it to resolve clicks. It approximates the
 * browser's rules (no CSS is applied, so an element hidden only by a stylesheet still counts); the
 * Chrome test in `chrome.test.ts` checks the two agree on the saved pages that matter.
 */
import { parse, type HTMLElement, type Node } from "node-html-parser";
import { normaliseText } from "../selectors";
import type { Role, Target } from "./page";

const NEVER_SHOWN = new Set(["head", "script", "style", "template", "noscript"]);
const TEXTBOX_INPUTS = new Set(["", "text", "email", "search", "tel", "url"]);
const BUTTON_INPUTS = new Set(["button", "submit", "reset"]);

/** Where candidates for a role are looked for; `roleOf` then decides. */
const CANDIDATES: Readonly<Record<Role, string>> = {
  button: "button, input, [role]",
  link: "a, [role]",
  textbox: "textarea, input, [role]",
  menuitem: "[role]",
};

/** Open dialogs: a native `<dialog open>`, or an element with a dialog role. */
const DIALOGS = "dialog, [role='dialog'], [role='alertdialog']";

/** Not verified on the live site. */
export function parseHtml(html: string): HTMLElement {
  return parse(html);
}

/** The element's role: its `role` attribute, else the one its tag implies. Not verified on the live site. */
export function roleOf(el: HTMLElement): string | null {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit !== undefined && explicit !== "") return explicit;
  const tag = el.rawTagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a") return el.hasAttribute("href") ? "link" : null;
  if (tag === "textarea") return "textbox";
  if (tag === "dialog") return "dialog";
  if (tag === "input") {
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (TEXTBOX_INPUTS.has(type)) return "textbox";
    if (BUTTON_INPUTS.has(type)) return "button";
  }
  return null;
}

/** Hidden from a person and from assistive technology: `hidden`, `aria-hidden`, a closed `<dialog>`, `display: none`. Not verified on the live site. */
export function isHidden(el: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node !== null; node = node.parentNode) {
    const tag = node.rawTagName?.toLowerCase();
    if (tag === undefined || tag === "") continue;
    if (NEVER_SHOWN.has(tag)) return true;
    if (node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return true;
    if (tag === "dialog" && !node.hasAttribute("open")) return true;
    if (/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.getAttribute("style") ?? "")) return true;
  }
  return false;
}

/** The accessible name, whitespace collapsed: aria-labelledby, aria-label, a label or placeholder of a field, else the text. Not verified on the live site. */
export function accessibleName(el: HTMLElement, root: HTMLElement): string {
  const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy !== undefined) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => root.querySelector(`[id=${JSON.stringify(id)}]`))
      .map((label) => (label === null ? "" : visibleText(label)))
      .join(" ");
    if (collapse(text) !== "") return collapse(text);
  }
  const label = collapse(el.getAttribute("aria-label") ?? "");
  if (label !== "") return label;
  const tag = el.rawTagName.toLowerCase();
  if (tag === "input" || tag === "textarea") {
    const id = el.getAttribute("id");
    const forIt = id === undefined ? null : root.querySelector(`label[for=${JSON.stringify(id)}]`);
    const fromLabel = forIt === null ? "" : collapse(visibleText(forIt));
    return fromLabel !== "" ? fromLabel : collapse(el.getAttribute("placeholder") ?? el.getAttribute("title") ?? "");
  }
  const text = collapse(visibleText(el));
  return text !== "" ? text : collapse(el.getAttribute("title") ?? "");
}

/** Text a person sees inside the element: hidden parts left out, an image counted by its alt. Not verified on the live site. */
function visibleText(el: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out += node.text;
      return;
    }
    if (!isElement(node)) return;
    const tag = node.rawTagName.toLowerCase();
    if (NEVER_SHOWN.has(tag) || node.getAttribute("aria-hidden") === "true" || node.hasAttribute("hidden")) return;
    if (tag === "img") out += ` ${node.getAttribute("alt") ?? ""} `;
    else node.childNodes.forEach(walk);
    if (tag === "p" || tag === "div" || tag === "br" || tag === "li") out += " ";
  };
  el.childNodes.forEach(walk);
  return out;
}

/** Not verified on the live site. */
function isElement(node: Node): node is HTMLElement {
  return node.nodeType === 1 && "rawTagName" in node;
}

/** The elements a scope covers: the root, or the matches of its CSS that hold a match of `has`. Not verified on the live site. */
function scopesOf(root: HTMLElement, target: Target): HTMLElement[] {
  const scope = target.within;
  if (scope === undefined) return [root];
  const all = root.querySelectorAll(scope.css);
  return scope.has === undefined ? all : all.filter((el) => el.querySelector(scope.has ?? "") !== null);
}

/** Every visible element matching the target, in document order. Not verified on the live site. */
export function findAll(root: HTMLElement, target: Target): HTMLElement[] {
  const seen = new Set<HTMLElement>();
  const found: HTMLElement[] = [];
  for (const scope of scopesOf(root, target)) {
    for (const role of target.roles) {
      for (const el of scope.querySelectorAll(CANDIDATES[role])) {
        if (seen.has(el) || roleOf(el) !== role || isHidden(el)) continue;
        if (target.name !== undefined && !target.name.test(accessibleName(el, root))) continue;
        seen.add(el);
        found.push(el);
      }
    }
  }
  return found.sort((a, b) => a.range[0] - b.range[0]);
}

/** The dialogs shown on the page, outermost only. Not verified on the live site. */
export function openDialogs(root: HTMLElement): HTMLElement[] {
  const shown = root.querySelectorAll(DIALOGS).filter((el) => !isHidden(el));
  return shown.filter((el) => !shown.some((other) => other !== el && isInsideOf(el, other)));
}

/** Not verified on the live site. */
function isInsideOf(el: HTMLElement, ancestor: HTMLElement): boolean {
  for (let node = el.parentNode; node !== null; node = node.parentNode) if (node === ancestor) return true;
  return false;
}

/** The visible text of an element in the form wording is stored in (lower case, straight apostrophes). Not verified on the live site. */
export function normalisedText(el: HTMLElement): string {
  return normaliseText(visibleText(el));
}

/** The text of a field as the page holds it: a textarea's content, an input's value, else the visible text. Not verified on the live site. */
export function fieldText(el: HTMLElement): string {
  const tag = el.rawTagName.toLowerCase();
  if (tag === "input") return el.getAttribute("value") ?? "";
  if (tag === "textarea") return el.text;
  return visibleText(el).replace(/\s+/g, " ").trim();
}
