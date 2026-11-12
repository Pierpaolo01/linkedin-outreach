import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataPaths, type DataPaths } from "../config/paths";
import { ensureDataDir } from "../db/index";
import { isPortListening, restoreBackup } from "./restore";

let dir: string;
let paths: DataPaths;

const NOW = new Date("2026-11-12T08:15:30Z");
const notRunning = async () => false;

function makeDb(file: string, value: string): void {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE marker (v TEXT); INSERT INTO marker VALUES ('${value}')`);
  db.close();
}

function marker(file: string): string {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row: unknown = db.prepare("SELECT v FROM marker").get();
    return typeof row === "object" && row !== null && "v" in row ? String(row.v) : "";
  } finally {
    db.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lo-restore-"));
  paths = dataPaths(join(dir, "data"));
  ensureDataDir(paths);
  makeDb(paths.db, "current");
  makeDb(join(paths.backups, "app-2026-11-10.db"), "backup of the 10th");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("restoreBackup", () => {
  it("copies the current database aside, then puts the named backup in its place", async () => {
    const outcome = await restoreBackup({ paths, backup: "app-2026-11-10.db", now: NOW, isAppRunning: notRunning });

    const aside = join(paths.root, "app.db.before-restore-2026-11-12T08-15-30Z");
    expect(outcome).toEqual({ kind: "restored", from: join(paths.backups, "app-2026-11-10.db"), aside });
    expect(marker(paths.db)).toBe("backup of the 10th");
    expect(marker(aside)).toBe("current");
    expect(statSync(paths.db).mode & 0o777).toBe(0o600);
    expect(statSync(aside).mode & 0o777).toBe(0o600);
    expect(marker(join(paths.backups, "app-2026-11-10.db"))).toBe("backup of the 10th");
  });

  it("accepts a path to the backup as well as its name", async () => {
    const file = join(paths.backups, "app-2026-11-10.db");
    expect((await restoreBackup({ paths, backup: file, now: NOW, isAppRunning: notRunning })).kind).toBe("restored");
  });

  it("drops the old database's WAL files so they cannot be replayed onto the restored one", async () => {
    writeFileSync(`${paths.db}-wal`, "stale");
    writeFileSync(`${paths.db}-shm`, "stale");
    await restoreBackup({ paths, backup: "app-2026-11-10.db", now: NOW, isAppRunning: notRunning });
    expect(existsSync(`${paths.db}-wal`)).toBe(false);
    expect(marker(paths.db)).toBe("backup of the 10th");
  });

  it("refuses while the app is running and changes nothing", async () => {
    const outcome = await restoreBackup({ paths, backup: "app-2026-11-10.db", now: NOW, isAppRunning: async () => true });
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toMatch(/running/);
    expect(marker(paths.db)).toBe("current");
    expect(readdirSync(paths.root).filter((n) => n.includes("before-restore"))).toEqual([]);
  });

  it("refuses a backup that does not exist", async () => {
    const outcome = await restoreBackup({ paths, backup: "app-2020-01-01.db", now: NOW, isAppRunning: notRunning });
    expect(outcome.kind).toBe("refused");
    expect(marker(paths.db)).toBe("current");
  });

  it("refuses a damaged backup and changes nothing", async () => {
    writeFileSync(join(paths.backups, "app-2026-11-09.db"), "not a database".repeat(400));
    const outcome = await restoreBackup({ paths, backup: "app-2026-11-09.db", now: NOW, isAppRunning: notRunning });
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toMatch(/integrity|not a database/);
    expect(marker(paths.db)).toBe("current");
  });

  it("restores when there is no current database, with nothing to copy aside", async () => {
    rmSync(paths.db);
    const outcome = await restoreBackup({ paths, backup: "app-2026-11-10.db", now: NOW, isAppRunning: notRunning });
    expect(outcome).toEqual({ kind: "restored", from: join(paths.backups, "app-2026-11-10.db"), aside: null });
    expect(marker(paths.db)).toBe("backup of the 10th");
  });

  it("copies a damaged current database aside byte for byte", async () => {
    writeFileSync(paths.db, "garbage".repeat(1000));
    const outcome = await restoreBackup({ paths, backup: "app-2026-11-10.db", now: NOW, isAppRunning: notRunning });
    expect(outcome.kind).toBe("restored");
    const aside = outcome.kind === "restored" ? outcome.aside : null;
    expect(aside !== null && statSync(aside).size).toBe(7000);
  });
});

describe("isPortListening", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it("is true while something listens on the port and false once it stops", async () => {
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    expect(await isPortListening(port)).toBe(true);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    expect(await isPortListening(port)).toBe(false);
  });
});
