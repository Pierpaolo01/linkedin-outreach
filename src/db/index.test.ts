import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataPaths } from "../config/paths";
import { ensureDataDir, openDb } from "./index";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lo-db-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tableNames(file: string): string[] {
  const { sqlite, close } = openDb(file);
  const rows = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  close();
  return rows.map((r) => r.name);
}

describe("openDb", () => {
  it("creates every table on an empty file", () => {
    expect(tableNames(join(dir, "app.db"))).toEqual([
      "__drizzle_migrations",
      "actions",
      "campaigns",
      "discovery_runs",
      "event_log",
      "people",
      "prospects",
      "safety_stops",
      "session_state",
      "settings",
    ]);
  });

  it("is a no-op the second time", () => {
    const file = join(dir, "app.db");
    const first = openDb(file);
    const applied = first.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number };
    first.close();

    const second = openDb(file);
    const again = second.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number };
    second.close();

    expect(applied.n).toBeGreaterThan(0);
    expect(again.n).toBe(applied.n);
  });

  it("turns on WAL and foreign keys", () => {
    const { sqlite, close } = openDb(join(dir, "app.db"));
    expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
    // FULL (2) plus fullfsync: a committed write survives a power cut.
    expect(sqlite.pragma("synchronous", { simple: true })).toBe(2);
    expect(sqlite.pragma("fullfsync", { simple: true })).toBe(1);
    close();
  });

  it("skips the drive sync only when asked, for tests and the simulation", () => {
    const { sqlite, close } = openDb(join(dir, "app.db"), { durable: false });
    expect(sqlite.pragma("synchronous", { simple: true })).toBe(0);
    expect(sqlite.pragma("fullfsync", { simple: true })).toBe(0);
    close();
  });

  it("leaves an existing database's data untouched when reopened", () => {
    const file = join(dir, "app.db");
    const first = openDb(file);
    first.sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('timeZone', '\"UTC\"', 0)").run();
    first.close();
    const second = openDb(file);
    expect(second.sqlite.prepare("SELECT value FROM settings").get()).toEqual({ value: '"UTC"' });
    second.close();
  });

  it("creates a missing parent directory with mode 700", () => {
    const nested = join(dir, "data");
    openDb(join(nested, "app.db")).close();
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });
});

describe("ensureDataDir", () => {
  it("creates the data directory and its subfolders with mode 700, and can run again", () => {
    const paths = dataPaths(join(dir, "data"));
    ensureDataDir(paths);
    ensureDataDir(paths);
    for (const folder of [paths.root, paths.backups, paths.chromeProfile, paths.screenshots, paths.logs]) {
      expect(statSync(folder).mode & 0o777, folder).toBe(0o700);
    }
  });

  it("tightens a folder that already exists with looser permissions", () => {
    const paths = dataPaths(join(dir, "data"));
    mkdirSync(paths.logs, { recursive: true, mode: 0o755 });
    ensureDataDir(paths);
    expect(statSync(paths.logs).mode & 0o777).toBe(0o700);
  });
});
