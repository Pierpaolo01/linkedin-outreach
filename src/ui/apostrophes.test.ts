import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { DiscoveryWait } from "./apiSchemas";
import { asSentence, withStop } from "./format";
import { budgetNote, discoveryWaitSentence, failure, plainMessage } from "./words";

/**
 * Every apostrophe the user reads is the typographic one (’), never the typewriter one ('): "Today’s usage" and
 * "today’s allowance" in one hand. Checked on the source itself, so a new string cannot bring the straight one back.
 */

const UI = join(import.meta.dirname);
/** A straight apostrophe between two letters: a contraction or a possessive ("LinkedIn's", "don't"). */
const STRAIGHT = /\p{L}'\p{L}/u;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/** The text of every string, template part and piece of JSX text in a file (comments are not read). */
function shownStrings(path: string): { readonly text: string; readonly line: number }[] {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: { text: string; line: number }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      found.push({ text: node.text, line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    node.forEachChild(visit);
  };
  visit(file);
  return found;
}

describe("apostrophes", () => {
  it("no string in src/ui has a straight apostrophe between letters", () => {
    const straight = sources(UI).flatMap((path) =>
      shownStrings(path)
        .filter(({ text }) => STRAIGHT.test(text))
        .map(({ text, line }) => `${relative(UI, path)}:${line}: ${text.trim().slice(0, 80)}`),
    );
    expect(straight).toEqual([]);
  });

  // The server's own words (D-10) keep their straight apostrophes at the source; what the dashboard shows of them does not.
  it("turns the server's straight apostrophes into typographic ones where the dashboard shows its words", () => {
    expect(plainMessage("Viewed the profile of Anna's company")).toBe("Viewed the profile of Anna’s company.");
    expect(asSentence("complete LinkedIn's check in the app's window")).toBe("Complete LinkedIn’s check in the app’s window.");
    expect(withStop("the person's text")).toBe("the person’s text.");
    expect(failure("The test did not run.", { message: "the model isn't available", status: 500 }).detail).toBe("What the app said: the model isn’t available.");
    // A quote mark that is not between letters stays: it is not an apostrophe.
    expect(withStop("they said 'yes'")).toBe("they said 'yes'.");
  });

  it("the words the app writes itself use the typographic apostrophe", () => {
    const now = new Date("2026-11-12T09:00:00Z");
    const lines = [
      budgetNote({ kind: "invite", budget: { used: 1, limit: 5, open: true, resumesAt: null }, warmUpTarget: 20, timeZone: "Europe/Rome", now }),
      ...[true, false].flatMap((safetyStop) =>
        (
          [
            { reason: "search_limit", until: "2026-12-01T00:00:00Z", message: "" },
            { reason: "no_new_people", until: null, message: "" },
            { reason: "unreadable", until: "2026-12-01T00:00:00Z", message: "" },
            { reason: "exhausted", until: null, message: "" },
          ] satisfies DiscoveryWait[]
        ).map((wait) => discoveryWaitSentence({ wait, timeZone: "Europe/Rome", safetyStop })),
      ),
    ];
    for (const line of lines) expect(line ?? "").not.toMatch(STRAIGHT);
    expect(lines.join(" ")).toContain("LinkedIn’s");
  });
});
