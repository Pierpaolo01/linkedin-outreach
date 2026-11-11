import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard over every committed fixture: nothing that identifies a real person may be left.
 *
 * Hand-written `synthetic-*.html` fixtures hold invented identifiers on purpose (the thread
 * parser tells senders apart by member id and urn, which the scrubber removes from real pages,
 * and one session fixture tests that script content is ignored), so the three form rules below
 * do not apply to them. Never name a scrubbed capture `synthetic-*`.
 */
const HAND_WRITTEN_EXEMPT = new Set([
  "profile ids other than person-<n>",
  "urn values not in the ID<n> form",
  "scripts with content",
]);
const ROOT = join(import.meta.dirname, "..", "..");
const FIXTURES = join(ROOT, "fixtures");

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

const all = (html: string, pattern: RegExp) => [...html.matchAll(pattern)].map((m) => m[0]);

/** Each check returns the offending strings; an empty list passes. */
const checks: Record<string, (html: string) => string[]> = {
  "photo or CDN URLs (media.licdn.com)": (html) => all(html, /media\.licdn\.com/g),
  "profile ids other than person-<n>": (html) =>
    all(html, /\/in\/[^/?#"'\s<>&\\]+/g).filter((link) => !/^\/in\/person-\d+$/.test(link)),
  "company slugs other than company-<n>": (html) =>
    all(html, /\/company\/[^/?#"'\s<>&\\]+/g).filter((link) => !/^\/company\/company-\d+$/.test(link)),
  "school slugs other than school-<n>": (html) =>
    all(html, /\/school\/[^/?#"'\s<>&\\]+/g).filter((link) => !/^\/school\/school-\d+$/.test(link)),
  "email addresses other than person@example.com": (html) =>
    all(html, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g).filter(
      (email) => email !== "person@example.com",
    ),
  "urn values not in the ID<n> form": (html) =>
    all(html, /urn:li:[A-Za-z_]+:[^\s"'<>&]*/g).filter((urn) => !/^urn:li:[A-Za-z_]+:ID\d+(?![A-Za-z0-9=+(-])/.test(urn)),
  "scripts with content": (html) => all(html, /<script\b[^>]*>(?!\s*<\/script\s*>)[\s\S]*?<\/script\s*>/gi),
};

const files = htmlFiles(FIXTURES);

describe("committed fixtures", () => {
  it("exist", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  describe.each(files.map((path) => [relative(ROOT, path), path] as const))("%s", (_name, path) => {
    const html = readFileSync(path, "utf8");

    const handWritten = (path.split("/").at(-1) ?? "").startsWith("synthetic-");
    const applicable = Object.entries(checks).filter(([name]) => !(handWritten && HAND_WRITTEN_EXEMPT.has(name)));

    it.each(applicable)("has no %s", (_check, find) => {
      expect(find(html).map((hit) => hit.slice(0, 80))).toEqual([]);
    });
  });
});
