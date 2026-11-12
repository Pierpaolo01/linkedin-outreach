import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { DataPaths } from "../config/paths";
import { dayKey } from "../engine/workingWindow";

/**
 * Daily backups of `app.db` (spec section 4): SQLite's online backup into
 * `backups/app-YYYY-MM-DD.db`, mode 600, newest 7 kept. A copy is checked with
 * `PRAGMA integrity_check` before it replaces or outlives anything, so a
 * damaged database never pushes a good backup out.
 */

export type BackupOutcome =
  | { readonly kind: "created"; readonly file: string; readonly bytes: number; readonly removed: readonly string[] }
  | { readonly kind: "skipped"; readonly file: string }
  | { readonly kind: "failed"; readonly error: string };

export interface BackupOptions {
  /** Time zone whose calendar date names the file. Default: the Mac's own. */
  readonly timeZone?: string;
  /** Backups kept, newest first. */
  readonly keep?: number;
}

export interface BackupFile {
  /** "YYYY-MM-DD" */
  readonly date: string;
  readonly name: string;
  readonly file: string;
  readonly bytes: number;
}

export const KEEP_BACKUPS = 7;
const NAME = /^app-(\d{4}-\d{2}-\d{2})\.db$/;
const TEMP = /^\.app-.*\.tmp(-wal|-shm|-journal)?$/;
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;

type BackupPaths = Pick<DataPaths, "backups">;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function backupFileName(date: string): string {
  return `app-${date}.db`;
}

/** The backups in `backups/`, newest date first. */
export function listBackups(paths: BackupPaths): BackupFile[] {
  if (!existsSync(paths.backups)) return [];
  const found: BackupFile[] = [];
  for (const name of readdirSync(paths.backups)) {
    const date = NAME.exec(name)?.[1];
    if (date === undefined) continue;
    const file = join(paths.backups, name);
    const stat = statSync(file);
    if (stat.isFile()) found.push({ date, name, file, bytes: stat.size });
  }
  return found.sort((a, b) => b.date.localeCompare(a.date));
}

/** "ok" when the file is a sound SQLite database, otherwise what is wrong with it. Opens it read-only. */
export function integrityOf(file: string): string {
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    return String(db.pragma("integrity_check", { simple: true }));
  } catch (error) {
    return message(error);
  } finally {
    db?.close();
  }
}

function removeStaleTemps(dir: string, now: Date): void {
  for (const name of readdirSync(dir)) {
    if (!TEMP.test(name)) continue;
    const file = join(dir, name);
    if (now.getTime() - statSync(file).mtimeMs > STALE_TEMP_MS) rmSync(file, { force: true });
  }
}

/**
 * Turns a fresh copy into a single self-contained file (the live database runs in WAL mode,
 * and a copy left in it grows -wal and -shm files whenever it is opened), then checks it.
 */
function sealCopy(file: string): string {
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { fileMustExist: true });
    db.pragma("journal_mode = DELETE");
    return String(db.pragma("integrity_check", { simple: true }));
  } catch (error) {
    return message(error);
  } finally {
    db?.close();
  }
}

function removeWithSidecars(file: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${file}${suffix}`, { force: true });
}

async function makeBackup(db: Database.Database, paths: BackupPaths, now: Date, options: BackupOptions) {
  const date = dayKey(options.timeZone ?? systemTimeZone(), now);
  const final = join(paths.backups, backupFileName(date));
  const temp = join(paths.backups, `.app-${date}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
    chmodSync(paths.backups, 0o700);
    removeStaleTemps(paths.backups, now);
    // Created empty with mode 600 first, so the copy is never readable by others, not even briefly.
    writeFileSync(temp, "", { mode: 0o600, flag: "wx" });
    await db.backup(temp);
    const integrity = sealCopy(temp);
    if (integrity !== "ok") {
      removeWithSidecars(temp);
      return { kind: "failed", error: `the copy failed its integrity check: ${integrity}` } as const;
    }
    chmodSync(temp, 0o600);
    renameSync(temp, final);
  } catch (error) {
    removeWithSidecars(temp);
    return { kind: "failed", error: message(error) } as const;
  }

  // The new copy is sound, so the oldest ones may go; the new one never does.
  const removed: string[] = [];
  for (const old of listBackups(paths).slice(options.keep ?? KEEP_BACKUPS)) {
    if (old.file === final) continue;
    rmSync(old.file, { force: true });
    removed.push(old.file);
  }
  return { kind: "created", file: final, bytes: statSync(final).size, removed: removed.sort() } as const;
}

/** One backup at a time per folder, so two callers never race on the same file. */
const running = new Map<string, Promise<unknown>>();

function serialised<T>(paths: BackupPaths, work: () => Promise<T>): Promise<T> {
  const previous = running.get(paths.backups) ?? Promise.resolve();
  const next = previous.then(work, work);
  running.set(paths.backups, next);
  void next.finally(() => {
    if (running.get(paths.backups) === next) running.delete(paths.backups);
  });
  return next;
}

/**
 * Today's backup unless it exists already. For the app to call at start and
 * then about once an hour (a skip costs one directory read). Never throws.
 */
export function backupIfDue(
  db: Database.Database,
  paths: BackupPaths,
  now: Date,
  options: BackupOptions = {},
): Promise<BackupOutcome> {
  return serialised(paths, async () => {
    const date = dayKey(options.timeZone ?? systemTimeZone(), now);
    const today = join(paths.backups, backupFileName(date));
    if (existsSync(today)) return { kind: "skipped", file: today } as const;
    return makeBackup(db, paths, now, options);
  });
}

/** A fresh backup now, replacing today's once the new copy checks out (`npm run backup`, `npm run update`). */
export function backupNow(
  db: Database.Database,
  paths: BackupPaths,
  now: Date,
  options: BackupOptions = {},
): Promise<BackupOutcome> {
  return serialised(paths, () => makeBackup(db, paths, now, options));
}
