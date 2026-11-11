/**
 * DOM helpers more than one parser uses. No selectors and no wording live here:
 * those belong to the page's `selectors.<page>.ts`.
 */
import type { HTMLElement } from "node-html-parser";
import { publicIdFromUrl } from "./card";

/** Single-line text of an element, whitespace collapsed, case kept. Empty for a missing element. */
export function inlineText(element: HTMLElement | null): string {
  return element === null ? "" : element.text.replace(/\s+/g, " ").trim();
}

export function isInside(element: HTMLElement, ancestor: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node !== null; node = node.parentNode) {
    if (node === ancestor) return true;
  }
  return false;
}

/** The public identifier a link's `href` points to. Undefined when it is not a profile link. */
export function publicIdOfLink(link: HTMLElement): string | undefined {
  return publicIdFromUrl(link.getAttribute("href") ?? "");
}

/** The first of the links that points to a profile, with its public identifier. */
export function firstProfileLink(links: readonly HTMLElement[]): { element: HTMLElement; publicId: string } | undefined {
  for (const element of links) {
    const publicId = publicIdOfLink(element);
    if (publicId !== undefined) return { element, publicId };
  }
  return undefined;
}
