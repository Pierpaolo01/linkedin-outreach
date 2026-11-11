import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Checkpoint, LinkedInError, LoggedOut, Restricted, Unexpected } from "./errors";
import { assertHealthy } from "./pageHealth";

function fakePage(url: string, html: string) {
  return {
    url: () => url,
    content: async () => html,
    screenshot: async ({ path }: { path: string }) => {
      writeFileSync(path, "png");
      return Buffer.from("png");
    },
  };
}

const signedIn = '<html lang="en"><body><header id="global-nav"></header></body></html>';
const fixedNow = () => new Date("2026-11-11T10:20:30.456Z");

describe("assertHealthy", () => {
  it("returns the classification on a healthy page and saves nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "health-"));

    const result = await assertHealthy(fakePage("https://www.linkedin.com/feed/", signedIn), { screenshotsDir: dir });

    expect(result.state).toBe("ok");
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([
    ["https://www.linkedin.com/authwall?trk=x", "<html></html>", LoggedOut, "logged_out"],
    ["https://www.linkedin.com/checkpoint/challenge/x", "<html></html>", Checkpoint, "checkpoint"],
    ["https://www.linkedin.com/feed/", "<p>Il tuo account è stato limitato</p>", Restricted, "restricted"],
    ["https://www.linkedin.com/feed/", "<html><body></body></html>", Unexpected, "unexpected"],
  ] as const)("on %s throws %o with the saved page", async (url, html, ErrorClass, kind) => {
    const dir = join(mkdtempSync(join(tmpdir(), "health-")), "screenshots");

    const error: unknown = await assertHealthy(fakePage(url, html), { screenshotsDir: dir, now: fixedNow }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ErrorClass);
    if (!(error instanceof LinkedInError) || error.artifacts === undefined) throw new Error("no artifacts");
    expect(error.kind).toBe(kind);
    expect(error.artifacts.screenshot).toMatch(/2026-11-11T10-20-30-456Z-.+\.png$/);
    expect(existsSync(error.artifacts.screenshot ?? "")).toBe(true);
    expect(readFileSync(error.artifacts.html, "utf8")).toBe(html);
    expect(error.message).toContain(error.artifacts.screenshot);
    expect(error.message).toContain(error.artifacts.html);
  });

  it("still throws the typed error when the screenshot fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "health-"));
    const page = {
      ...fakePage("https://www.linkedin.com/login", "<html></html>"),
      screenshot: async () => {
        throw new Error("Target closed");
      },
    };

    const error: unknown = await assertHealthy(page, { screenshotsDir: dir }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LoggedOut);
    if (!(error instanceof LoggedOut) || error.artifacts === undefined) throw new Error("no artifacts");
    expect(error.artifacts.screenshot).toBeUndefined();
    expect(readFileSync(error.artifacts.html, "utf8")).toBe("<html></html>");
    expect(error.message).toContain("screenshot (failed)");
  });
});
