import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataPaths, type DataPaths } from "../config/paths";
import { ensureDataDir, openDb } from "../db/index";
import { eventLog, sessionState } from "../db/schema";
import { formatReport, runDoctor, type DoctorOptions } from "./checks";

let dir: string;
let paths: DataPaths;
let chromeApp: string;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>142.0.7444.60</string></dict></plist>
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lo-doctor-"));
  paths = dataPaths(join(dir, "data"));
  chromeApp = join(dir, "Google Chrome.app");
  mkdirSync(join(chromeApp, "Contents"), { recursive: true });
  writeFileSync(join(chromeApp, "Contents", "Info.plist"), INFO_PLIST);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function healthyInstall(): void {
  ensureDataDir(paths);
  openDb(paths.db).close();
}

function options(overrides: Partial<DoctorOptions> = {}): DoctorOptions {
  return { paths, chromeApp, nodeVersion: "22.23.2", ...overrides };
}

function check(name: string, opts: DoctorOptions = options()) {
  const found = runDoctor(opts).checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found;
}

describe("runDoctor", () => {
  it("reports OK for a healthy install", () => {
    healthyInstall();
    const report = runDoctor(options());
    expect(report.checks.filter((c) => c.status === "problem")).toEqual([]);
    expect(report.ok).toBe(true);
    const text = formatReport(report);
    expect(text).toContain("142.0.7444.60");
    expect(text).toContain("migrations applied 1 of 1");
    expect(text).toContain("auto-start: not installed (arrives in milestone 4)");
    expect(text.trimEnd().split("\n").at(-1)).toBe("doctor: OK");
  });

  it("reports a problem when the database is missing, without creating it", () => {
    ensureDataDir(paths);
    const report = runDoctor(options());
    expect(report.ok).toBe(false);
    expect(check("database").status).toBe("problem");
    expect(check("database").fix).toMatch(/npm run setup/);
    expect(existsSync(paths.db)).toBe(false);
    expect(formatReport(report).trimEnd().split("\n").at(-1)).toMatch(/^doctor: PROBLEMS \(\d+\)$/);
  });

  it("reports a problem when the database file is corrupt", () => {
    ensureDataDir(paths);
    writeFileSync(paths.db, "this is not a sqlite database, just bytes".repeat(200));
    const db = check("database");
    expect(db.status).toBe("problem");
    expect(db.fix).toMatch(/backups/);
  });

  it("reports a problem when the database has damaged pages behind a valid header", () => {
    healthyInstall();
    const bytes = readFileSync(paths.db);
    bytes.fill(0xff, 4096 * 2, 4096 * 4);
    writeFileSync(paths.db, bytes);
    const db = check("database");
    expect(db.status).toBe("problem");
    expect(db.detail).toMatch(/integrity_check failed|malformed|not a database/);
  });

  it("reports a problem when migrations have not been applied", () => {
    ensureDataDir(paths);
    const raw = new Database(paths.db);
    raw.exec("CREATE TABLE unrelated (x)");
    raw.close();
    const db = check("database");
    expect(db.status).toBe("problem");
    expect(db.detail).toContain("migrations applied 0 of 1");
  });

  it("reports a problem when Chrome is missing", () => {
    healthyInstall();
    const chrome = check("chrome", options({ chromeApp: join(dir, "Nope.app") }));
    expect(chrome.status).toBe("problem");
    expect(chrome.fix).toMatch(/brew install --cask google-chrome/);
  });

  it("reports a problem for Node older than 22", () => {
    healthyInstall();
    expect(check("node", options({ nodeVersion: "20.11.0" })).status).toBe("problem");
  });

  it("reports a problem when a data subfolder is missing", () => {
    healthyInstall();
    rmSync(paths.screenshots, { recursive: true });
    const data = check("data directory");
    expect(data.status).toBe("problem");
    expect(data.detail).toContain("screenshots");
  });

  it("reports a safety stop recorded in session_state as a problem", () => {
    healthyInstall();
    const { db, close } = openDb(paths.db);
    db.insert(sessionState)
      .values({ id: 1, status: "checkpoint", lastCheckedAt: new Date("2026-11-11T10:00:00Z"), lastError: "CAPTCHA page" })
      .run();
    close();
    const session = check("session");
    expect(session.status).toBe("problem");
    expect(session.detail).toContain("checkpoint");
    expect(session.detail).toContain("2026-11-11T10:00:00.000Z");
    expect(session.detail).toContain("CAPTCHA page");
  });

  it("shows recent errors from the event log and the tail of the newest log file", () => {
    healthyInstall();
    const { db, close } = openDb(paths.db);
    db.insert(eventLog).values({ at: new Date(), level: "error", message: "Profile page did not load" }).run();
    close();
    writeFileSync(join(paths.logs, "old.log"), "old line\n");
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    writeFileSync(join(paths.logs, "app.log"), `${lines}\n`);
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(paths.logs, "app.log"), later, later);

    const report = runDoctor(options());
    const text = formatReport(report);
    expect(text).toContain("Profile page did not load");
    expect(text).toContain("app.log");
    expect(text).toContain("line 30");
    expect(text).not.toContain("line 1\n");
    expect(text).not.toContain("old line");
    expect(report.ok).toBe(true);
  });
});
