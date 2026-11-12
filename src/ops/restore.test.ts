import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataPaths, type DataPaths } from "../config/paths";
import { ensureDataDir } from "../db/index";
import { LOCK_FILE } from "../worker/instanceLock";
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

describe("restoreBackup and the app's instance lock", () => {
  let holder: ChildProcess | undefined;
  afterEach(() => {
    holder?.kill("SIGKILL");
    holder = undefined;
  });

  /** A live process, standing in for an app started in a terminal on another PORT. */
  async function liveProcess(): Promise<number> {
    holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => holder?.once("spawn", () => resolve()));
    const pid = holder.pid;
    if (pid === undefined) throw new Error("the stand-in app did not start");
    return pid;
  }

  it("refuses while a live process holds app.lock, says which one, and leaves every byte as it was", async () => {
    const pid = await liveProcess();
    writeFileSync(join(paths.root, LOCK_FILE), String(pid));
    writeFileSync(`${paths.db}-wal`, "the running app's WAL");
    const before = readFileSync(paths.db);

    const outcome = await restoreBackup({ paths, backup: "app-2026-11-10.db", now: NOW, isAppRunning: notRunning });

    expect(outcome.kind).toBe("refused");
    expect(outcome.kind === "refused" && outcome.reason).toContain(`process ${pid}`);
    expect(readFileSync(paths.db).equals(before)).toBe(true);
    expect(readFileSync(`${paths.db}-wal`, "utf8")).toBe("the running app's WAL");
    expect(readdirSync(paths.root).filter((n) => n.includes("before-restore") || n.includes("restoring"))).toEqual([]);
    expect(readFileSync(join(paths.root, LOCK_FILE), "utf8")).toBe(String(pid));
  });

  it("takes over a stale lock, restores, and leaves no lock behind", async () => {
    writeFileSync(join(paths.root, LOCK_FILE), String(spawnSync(process.execPath, ["-e", ""]).pid));

    const outcome = await restoreBackup({ paths, backup: "app-2026-11-10.db", now: NOW, isAppRunning: notRunning });

    expect(outcome.kind).toBe("restored");
    expect(marker(paths.db)).toBe("backup of the 10th");
    expect(existsSync(join(paths.root, LOCK_FILE))).toBe(false);
  });

  it("holds the lock for the whole run, so an app started meanwhile cannot open the database", async () => {
    let lockDuringRun: string | null = null;
    const outcome = await restoreBackup({
      paths,
      backup: "app-2026-11-10.db",
      now: NOW,
      isAppRunning: async () => {
        lockDuringRun = existsSync(join(paths.root, LOCK_FILE)) ? readFileSync(join(paths.root, LOCK_FILE), "utf8") : null;
        return false;
      },
    });
    expect(outcome.kind).toBe("restored");
    expect(lockDuringRun).toBe(String(process.pid));
    expect(existsSync(join(paths.root, LOCK_FILE))).toBe(false);
  });

  it("releases the lock when the restore fails part way", async () => {
    rmSync(paths.db);
    // A directory where the database goes: the final rename fails.
    mkdirSync(paths.db);
    writeFileSync(join(paths.db, "x"), "x");

    await expect(restoreBackup({ paths, backup: "app-2026-11-10.db", now: NOW, isAppRunning: notRunning })).rejects.toThrow();
    expect(existsSync(join(paths.root, LOCK_FILE))).toBe(false);
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
