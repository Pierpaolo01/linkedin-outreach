import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataPaths, type DataPaths } from "../config/paths";
import { ensureDataDir, openDb } from "../db/index";
import { eventLog, sessionState } from "../db/schema";
import type { Launchctl, ServiceContext } from "../ops/service";
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

const LABEL = "com.linkedin-outreach.app";
const notLoaded: Launchctl = () => ({ code: 113, stdout: "", stderr: "Could not find service" });

function service(launchctl: Launchctl = notLoaded): ServiceContext {
  return { label: LABEL, launchAgentsDir: join(dir, "LaunchAgents"), uid: 501, launchctl };
}

function printed(fields: string): Launchctl {
  return () => ({ code: 0, stdout: `gui/501/${LABEL} = {\n${fields}\n\tsubsystem = {\n\t\tstate = active\n\t}\n}`, stderr: "" });
}

function installPlist(): void {
  mkdirSync(join(dir, "LaunchAgents"), { recursive: true });
  writeFileSync(join(dir, "LaunchAgents", `${LABEL}.plist`), "<plist/>");
}

const NOW = new Date("2026-11-12T10:00:00Z");

function options(overrides: Partial<DoctorOptions> = {}): DoctorOptions {
  return { paths, chromeApp, nodeVersion: "22.23.2", service: service(), now: NOW, timeZone: "Europe/Rome", ...overrides };
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
    expect(text).toMatch(/migrations applied (\d+) of \1\b/);
    expect(text).toContain("auto-start: not installed (`npm run service:install` starts the app at login)");
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
    expect(db.fix).toContain("npm run restore -- <backup file>");
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
    expect(db.detail).toMatch(/migrations applied 0 of [1-9]\d*/);
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

describe("backups check", () => {
  function backup(date: string, bytes: number): void {
    writeFileSync(join(paths.backups, `app-${date}.db`), Buffer.alloc(bytes));
  }

  it("says there are none yet without calling it a problem", () => {
    healthyInstall();
    const backups = check("backups");
    expect(backups.status).toBe("info");
    expect(backups.detail).toContain("no backups yet");
  });

  it("lists backups newest first with dates and sizes, and how to restore", () => {
    healthyInstall();
    backup("2026-11-11", 2048);
    backup("2026-11-12", 1_572_864);
    const backups = check("backups");
    expect(backups.status).toBe("ok");
    expect(backups.detail).toBe(`2 in ${paths.backups}, newest 2026-11-12`);
    expect(backups.lines).toEqual([
      "app-2026-11-12.db  2026-11-12  1.5 MB",
      "app-2026-11-11.db  2026-11-11  2 KB",
      "to restore one: stop the app, then `npm run restore -- app-2026-11-12.db` (the current database is copied aside first)",
    ]);
  });

  it("notes when the newest backup is more than two days old", () => {
    healthyInstall();
    backup("2026-11-09", 4096);
    const backups = check("backups");
    expect(backups.status).toBe("info");
    expect(backups.detail).toContain("newest 2026-11-09, 3 days old");
  });
});

describe("service check", () => {
  it("reports a running service with its pid and last exit", () => {
    healthyInstall();
    installPlist();
    const svc = check("service", options({ service: service(printed("\tstate = running\n\tpid = 812\n\tlast exit code = 1")) }));
    expect(svc.status).toBe("ok");
    expect(svc.detail).toBe("auto-start: installed, loaded, running (pid 812), last exit: exit code 1");
  });

  it("reports a loaded service that is not running as a problem, with the end of its error log", () => {
    healthyInstall();
    installPlist();
    writeFileSync(join(paths.logs, "service.err.log"), "Error: boom\n    at main\n");
    const svc = check(
      "service",
      options({ service: service(printed("\tstate = not running\n\tlast terminating signal = Killed: 9")) }),
    );
    expect(svc.status).toBe("problem");
    expect(svc.detail).toBe("auto-start: installed and loaded but not running, last exit: signal Killed: 9");
    expect(svc.fix).toContain("npm run service:restart");
    expect(svc.lines).toEqual(["service.err.log:", "Error: boom", "    at main"]);
  });

  it("shows no error-log lines when the error log is empty", () => {
    healthyInstall();
    installPlist();
    writeFileSync(join(paths.logs, "service.err.log"), "");
    const svc = check("service", options({ service: service(printed("\tstate = not running\n\tlast exit code = 0")) }));
    expect(svc.status).toBe("problem");
    expect(svc.lines).toBeUndefined();
  });

  it("reports an installed service that launchd has not loaded", () => {
    healthyInstall();
    installPlist();
    const svc = check("service");
    expect(svc.status).toBe("problem");
    expect(svc.fix).toContain("npm run service:install");
  });

  it("reports a loaded job whose plist is gone", () => {
    healthyInstall();
    const svc = check("service", options({ service: service(printed("\tstate = running\n\tpid = 3")) }));
    expect(svc.status).toBe("problem");
    expect(svc.fix).toContain("npm run service:uninstall");
  });
});

describe("log tail", () => {
  it("prefers app.log over newer service logs", () => {
    healthyInstall();
    writeFileSync(join(paths.logs, "app.log"), "app line\n");
    writeFileSync(join(paths.logs, "service.out.log"), "service line\n");
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(paths.logs, "service.out.log"), later, later);
    const logs = check("log tail");
    expect(logs.detail).toBe(join(paths.logs, "app.log"));
    expect(logs.lines).toEqual(["app line"]);
  });
});
