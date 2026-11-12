import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileLogger } from "./log";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lo-log-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const at = new Date("2026-11-12T08:30:00.000Z");

describe("createFileLogger", () => {
  it("appends dated lines with level and fields to logs/app.log, mode 600", () => {
    const log = createFileLogger({ dir: join(dir, "logs"), now: () => at });
    log.info("backup created", { file: "app-2026-11-12.db", bytes: 4096 });
    log.error("tick failed", { prospectId: 42 });

    const file = join(dir, "logs", "app.log");
    expect(readFileSync(file, "utf8")).toBe(
      "2026-11-12T08:30:00.000Z INFO backup created file=app-2026-11-12.db bytes=4096\n" +
        "2026-11-12T08:30:00.000Z ERROR tick failed prospectId=42\n",
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("keeps each entry on one line", () => {
    const log = createFileLogger({ dir, now: () => at });
    log.warn("first\nsecond", { reason: "a b\nc" });
    expect(readFileSync(join(dir, "app.log"), "utf8")).toBe(
      '2026-11-12T08:30:00.000Z WARN first\\nsecond reason="a b\\nc"\n',
    );
  });

  it("rotates by size and keeps five files", () => {
    const log = createFileLogger({ dir, now: () => at, maxBytes: 200 });
    for (let i = 0; i < 60; i++) log.info(`entry ${String(i).padStart(3, "0")}`, { pad: "x".repeat(40) });

    const files = readdirSync(dir).sort();
    expect(files).toEqual(["app.log", "app.log.1", "app.log.2", "app.log.3", "app.log.4"]);
    for (const name of files) {
      expect(statSync(join(dir, name)).size).toBeLessThanOrEqual(200);
      expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(join(dir, "app.log"), "utf8")).toContain("entry 059");
    expect(readFileSync(join(dir, "app.log.1"), "utf8")).not.toContain("entry 059");
    expect(existsSync(join(dir, "app.log.5"))).toBe(false);
  });

  it("picks up the size of an existing log after a restart", () => {
    createFileLogger({ dir, now: () => at, maxBytes: 200 }).info("x".repeat(150));
    createFileLogger({ dir, now: () => at, maxBytes: 200 }).info("y".repeat(150));
    expect(readFileSync(join(dir, "app.log.1"), "utf8")).toContain("x".repeat(150));
    expect(readFileSync(join(dir, "app.log"), "utf8")).toContain("y".repeat(150));
  });

  it("never throws when the log cannot be written", () => {
    const log = createFileLogger({ dir: "/dev/null/not-a-dir", now: () => at });
    expect(() => log.error("lost")).not.toThrow();
  });
});
