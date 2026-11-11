/**
 * Leak report for a fixture made from a capture:
 *   npx tsx scripts/scrub-check.ts <capture.html> <fixture.html>
 * Prints only what is in the fixture (and counts from the capture), never capture content.
 */
import { readFileSync, statSync } from "node:fs";

const [capturePath, fixturePath] = process.argv.slice(2);
if (capturePath === undefined || fixturePath === undefined) {
  console.error("usage: npx tsx scripts/scrub-check.ts <capture.html> <fixture.html>");
  process.exit(2);
}

const capture = readFileSync(capturePath, "utf8");
const fixture = readFileSync(fixturePath, "utf8");

const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;
const decode = (value: string) =>
  value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&(?:#39|#x27|apos);/g, "'")
    .replace(/&nbsp;/g, " ");

/** Visible text and attribute values of the fixture, the places a missed name would show. */
function readableStrings(html: string): string[] {
  const withoutHidden = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const attributeValues = [...withoutHidden.matchAll(/\s[^\s"'>/=]+\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(
    (m) => m[1] ?? m[2] ?? "",
  );
  const text = withoutHidden.replace(/<[^>]*>/g, "\n");
  return [text, ...attributeValues].map(decode);
}

/** Pairs of adjacent capitalised words, overlapping ("A B C" gives "A B" and "B C"). */
function capitalisedPairs(strings: readonly string[]): Map<string, number> {
  const pairs = new Map<string, number>();
  const pattern = /(?<![\p{L}\p{N}])(?=(\p{Lu}[\p{Ll}'\u2019-]+\s+\p{Lu}[\p{Ll}'\u2019-]+)(?![\p{L}\p{N}]))/gu;
  for (const value of strings) {
    for (const match of value.matchAll(pattern)) {
      const pair = (match[1] ?? "").replace(/\s+/g, " ");
      pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
    }
  }
  return pairs;
}

const kb = (path: string) => `${Math.round(statSync(path).size / 1024)} KB`;

console.log(`size: capture ${kb(capturePath)}, fixture ${kb(fixturePath)}`);
console.log(`data-testid attributes: capture ${count(capture, /\sdata-testid=/g)}, fixture ${count(fixture, /\sdata-testid=/g)}`);
console.log();
console.log("left in the fixture:");
console.log(`  /in/ links: ${count(fixture, /\/in\//g)} (not person-<n>: ${count(fixture, /\/in\/(?!person-\d+(?![\w-]))/g)})`);
console.log(`  /company/ links: ${count(fixture, /\/company\//g)} (not company-<n>: ${count(fixture, /\/company\/(?!company-\d+(?![\w-]))/g)})`);
console.log(`  licdn: ${count(fixture, /licdn/g)}`);
console.log(`  urn:li: ${count(fixture, /urn:li:/g)} (not ID<n>: ${count(fixture, /urn:li:[A-Za-z_]+:(?!ID\d+(?![A-Za-z0-9=+(-]))/g)})`);
console.log(`  email addresses other than person@example.com: ${count(fixture.replace(/person@example\.com/g, ""), /[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g)}`);
console.log();
console.log("most frequent capitalised word pairs in the fixture (likely missed names):");
const top = [...capitalisedPairs(readableStrings(fixture))].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40);
for (const [pair, n] of top) console.log(`  ${String(n).padStart(4)}  ${pair}`);
if (top.length === 0) console.log("  (none)");
