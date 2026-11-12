import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataPaths, type DataPaths } from "../config/paths";
import { ensureDataDir, openDb } from "../db/index";
import { backupIfDue, backupNow, listBackups } from "./backup";

let dir: string;
let paths: DataPaths;
let sqlite: Database.Database;

const TZ = "Europe/Rome";
// 23:30 UTC on 11 Nov is already 12 Nov in Rome.
const NOW = new Date("2026-11-11T23:30:00Z");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lo-backup-"));
  paths = dataPaths(join(dir, "data"));
  ensureDataDir(paths);
  openDb(paths.db, { durable: false }).close();
  sqlite = new Database(paths.db);
  sqlite.exec("CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('live')");
});

afterEach(() => {
  sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});

function marker(file: string): string {
  const copy = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row: unknown = copy.prepare("SELECT v FROM marker").get();
    return typeof row === "object" && row !== null && "v" in row ? String(row.v) : "";
  } finally {
    copy.close();
  }
}

/** A valid backup file for an earlier day, holding `value` in the marker table. */
function oldBackup(date: string, value = date): string {
  const file = join(paths.backups, `app-${date}.db`);
  const db = new Database(file);
  db.exec(`CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('${value}')`);
  db.close();
  return file;
}

function corruptLiveDatabase(): void {
  sqlite.close();
  const bytes = readFileSync(paths.db);
  bytes.fill(0xff, 4096 * 2, 4096 * 4);
  writeFileSync(paths.db, bytes);
  sqlite = new Database(paths.db);
}

describe("backupIfDue", () => {
  it("copies the live database into backups/ named by the local date, mode 600", async () => {
    const outcome = await backupIfDue(sqlite, paths, NOW, { timeZone: TZ });

    const file = join(paths.backups, "app-2026-11-12.db");
    expect(outcome).toEqual({ kind: "created", file, bytes: statSync(file).size, removed: [] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(marker(file)).toBe("live");
    expect(readdirSync(paths.backups)).toEqual(["app-2026-11-12.db"]);
  });

  it("skips when today's backup exists and leaves it as it is", async () => {
    const today = oldBackup("2026-11-12", "this morning");
    const outcome = await backupIfDue(sqlite, paths, NOW, { timeZone: TZ });
    expect(outcome).toEqual({ kind: "skipped", file: today });
    expect(marker(today)).toBe("this morning");
  });

  it("keeps the newest 7 and deletes older ones once the new copy checks out", async () => {
    for (let day = 1; day <= 8; day++) oldBackup(`2026-11-0${day}`);
    const outcome = await backupIfDue(sqlite, paths, NOW, { timeZone: TZ });

    expect(outcome.kind).toBe("created");
    expect(outcome.kind === "created" && outcome.removed.map((f) => f.split("/").at(-1))).toEqual([
      "app-2026-11-01.db",
      "app-2026-11-02.db",
    ]);
    expect(readdirSync(paths.backups).sort()).toEqual([
      "app-2026-11-03.db",
      "app-2026-11-04.db",
      "app-2026-11-05.db",
      "app-2026-11-06.db",
      "app-2026-11-07.db",
      "app-2026-11-08.db",
      "app-2026-11-12.db",
    ]);
  });

  it("deletes nothing and keeps no copy when the copy fails its integrity check", async () => {
    for (let day = 1; day <= 7; day++) oldBackup(`2026-11-0${day}`);
    corruptLiveDatabase();

    const outcome = await backupIfDue(sqlite, paths, NOW, { timeZone: TZ });

    expect(outcome.kind).toBe("failed");
    expect(readdirSync(paths.backups).sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((day) => `app-2026-11-0${day}.db`),
    );
  });

  it("makes one backup when called twice at once", async () => {
    const [a, b] = await Promise.all([
      backupIfDue(sqlite, paths, NOW, { timeZone: TZ }),
      backupIfDue(sqlite, paths, NOW, { timeZone: TZ }),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(["created", "skipped"]);
    expect(readdirSync(paths.backups)).toEqual(["app-2026-11-12.db"]);
  });

  it("creates the backups folder when it is missing", async () => {
    rmSync(paths.backups, { recursive: true });
    expect((await backupIfDue(sqlite, paths, NOW, { timeZone: TZ })).kind).toBe("created");
    expect(statSync(paths.backups).mode & 0o777).toBe(0o700);
  });
});

describe("backupNow", () => {
  it("replaces today's backup with a fresh copy", async () => {
    const today = oldBackup("2026-11-12", "this morning");
    const outcome = await backupNow(sqlite, paths, NOW, { timeZone: TZ });
    expect(outcome.kind).toBe("created");
    expect(marker(today)).toBe("live");
    expect(statSync(today).mode & 0o777).toBe(0o600);
  });

  it("keeps today's earlier backup when the fresh copy is damaged", async () => {
    const today = oldBackup("2026-11-12", "this morning");
    corruptLiveDatabase();
    expect((await backupNow(sqlite, paths, NOW, { timeZone: TZ })).kind).toBe("failed");
    expect(marker(today)).toBe("this morning");
    expect(readdirSync(paths.backups)).toEqual(["app-2026-11-12.db"]);
  });
});

describe("listBackups", () => {
  it("lists backups newest first with date and size, ignoring other files", () => {
    oldBackup("2026-11-03");
    oldBackup("2026-11-10");
    writeFileSync(join(paths.backups, "notes.txt"), "x");
    mkdirSync(join(paths.backups, "app-2026-11-11.db"));

    const list = listBackups(paths);
    expect(list.map((b) => b.date)).toEqual(["2026-11-10", "2026-11-03"]);
    expect(list[0]).toEqual({
      date: "2026-11-10",
      file: join(paths.backups, "app-2026-11-10.db"),
      name: "app-2026-11-10.db",
      bytes: statSync(join(paths.backups, "app-2026-11-10.db")).size,
    });
  });

  it("is empty when the folder does not exist", () => {
    rmSync(paths.backups, { recursive: true });
    expect(listBackups(paths)).toEqual([]);
    expect(existsSync(paths.backups)).toBe(false);
  });
});
