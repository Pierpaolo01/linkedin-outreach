import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isChromeMissing, profileLockHolder } from "./browser";

function profileDir(): string {
  return mkdtempSync(join(tmpdir(), "profile-"));
}

describe("profileLockHolder", () => {
  it("is undefined when no Chrome holds the profile", () => {
    expect(profileLockHolder(profileDir())).toBeUndefined();
  });

  it("names the live process that holds Chrome's SingletonLock", () => {
    const dir = profileDir();
    symlinkSync(`My-Mac.local-${process.pid}`, join(dir, "SingletonLock"));

    expect(profileLockHolder(dir)).toEqual({ host: "My-Mac.local", pid: process.pid });
  });

  it("ignores a stale lock left by a process that has exited", () => {
    const dir = profileDir();
    symlinkSync("My-Mac.local-2147483646", join(dir, "SingletonLock"));

    expect(profileLockHolder(dir)).toBeUndefined();
  });
});

describe("isChromeMissing", () => {
  it("recognises Playwright's missing-channel error", () => {
    const error = new Error(
      "browserType.launchPersistentContext: Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\nRun \"npx playwright install chrome\"",
    );
    expect(isChromeMissing(error)).toBe(true);
  });

  it("does not treat other launch failures as a missing Chrome", () => {
    expect(isChromeMissing(new Error("Target page, context or browser has been closed"))).toBe(false);
    expect(isChromeMissing("not an error")).toBe(false);
  });
});
