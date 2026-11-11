import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { DataPaths } from "../config/paths";
import { MIGRATIONS_DIR } from "../db/index";

/**
 * `npm run doctor`: a diagnosis the user's AI can act on (spec section 11).
 * Read-only: it never creates or migrates the database.
 */

export type CheckStatus = "ok" | "info" | "problem";

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** What to do about a problem. */
  readonly fix?: string;
  /** Extra lines printed under the check, such as a log tail. */
  readonly lines?: readonly string[];
}

export interface DoctorReport {
  readonly checks: readonly Check[];
  readonly problems: number;
  readonly ok: boolean;
}

export interface DoctorOptions {
  readonly paths: DataPaths;
  readonly chromeApp?: string;
  readonly nodeVersion?: string;
  readonly migrationsDir?: string;
}

export const CHROME_APP = "/Applications/Google Chrome.app";
const MIN_NODE_MAJOR = 22;
const LOG_TAIL_LINES = 20;
const LOG_TAIL_BYTES = 64 * 1024;
const RECENT_ERRORS = 5;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkNode(version: string): Check {
  const major = Number(version.split(".")[0]);
  return major >= MIN_NODE_MAJOR
    ? { name: "node", status: "ok", detail: `v${version}` }
    : {
        name: "node",
        status: "problem",
        detail: `v${version}, need ${MIN_NODE_MAJOR} or newer`,
        fix: `install Node ${MIN_NODE_MAJOR} LTS (for example \`brew install node@${MIN_NODE_MAJOR}\`), then run \`npm run setup\``,
      };
}

function chromeVersion(app: string): string {
  try {
    return execFileSync(
      "plutil",
      ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(app, "Contents", "Info.plist")],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return "version unknown";
  }
}

function checkChrome(app: string): Check {
  if (!existsSync(app)) {
    return {
      name: "chrome",
      status: "problem",
      detail: `Google Chrome not found at ${app}`,
      fix: "run `npm run setup` (it runs `brew install --cask google-chrome`)",
    };
  }
  return { name: "chrome", status: "ok", detail: `${chromeVersion(app)} at ${app}` };
}

function checkDataDir(paths: DataPaths): Check {
  const folders = [paths.root, paths.backups, paths.chromeProfile, paths.screenshots, paths.logs];
  const missing = folders.filter((f) => !existsSync(f));
  const lines = folders
    .filter((f) => existsSync(f))
    .map((f) => {
      const mode = statSync(f).mode & 0o777;
      return `${relative(paths.root, f) || "."} (mode ${mode.toString(8)}${mode === 0o700 ? "" : ", expected 700"})`;
    });
  if (missing.length > 0) {
    return {
      name: "data directory",
      status: "problem",
      detail: `missing: ${missing.join(", ")}`,
      fix: "run `npm run setup`",
      lines,
    };
  }
  return { name: "data directory", status: "ok", detail: paths.root, lines };
}

const journalSchema = z.object({ entries: z.array(z.unknown()) });

function expectedMigrations(dir: string): number {
  return journalSchema.parse(JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8"))).entries.length;
}

function hasTable(sqlite: Database.Database, name: string): boolean {
  return sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

const sessionRow = z.object({
  status: z.string(),
  last_checked_at: z.number().nullable(),
  last_error: z.string().nullable(),
});
const eventRow = z.object({ at: z.number(), message: z.string() });

function isoOrNever(ms: number | null): string {
  return ms === null ? "never" : new Date(ms).toISOString();
}

const SAFETY_STOP_STATUSES = new Set(["logged_out", "checkpoint", "restricted"]);

function checkSession(sqlite: Database.Database): Check {
  const raw = sqlite.prepare("SELECT status, last_checked_at, last_error FROM session_state WHERE id = 1").get();
  if (raw === undefined) return { name: "session", status: "ok", detail: "no LinkedIn session check recorded yet" };
  const row = sessionRow.parse(raw);
  const detail = `status ${row.status}, last check ${isoOrNever(row.last_checked_at)}, last error ${row.last_error ?? "none"}`;
  if (SAFETY_STOP_STATUSES.has(row.status)) {
    return {
      name: "session",
      status: "problem",
      detail,
      fix: "LinkedIn needs the user: they open the dedicated Chrome window and resolve it by hand. Never try to get past it automatically",
    };
  }
  if (row.status === "search_capped") {
    return { name: "session", status: "info", detail: `${detail} (discovery waits for next month; sequences continue)` };
  }
  return { name: "session", status: "ok", detail };
}

function checkRecentErrors(sqlite: Database.Database): Check {
  const rows = z
    .array(eventRow)
    .parse(
      sqlite
        .prepare("SELECT at, message FROM event_log WHERE level = 'error' ORDER BY at DESC, id DESC LIMIT ?")
        .all(RECENT_ERRORS),
    );
  if (rows.length === 0) return { name: "recent errors", status: "ok", detail: "none in event_log" };
  return {
    name: "recent errors",
    status: "info",
    detail: `last ${rows.length} from event_log`,
    lines: rows.map((r) => `${new Date(r.at).toISOString()} ${r.message}`),
  };
}

/** Database integrity and migrations, plus the checks that read from it. */
function checkDatabase(file: string, migrationsDir: string): Check[] {
  const fix = "run `npm run setup`";
  if (!existsSync(file)) {
    return [{ name: "database", status: "problem", detail: `not found at ${file}`, fix }];
  }
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(file, { fileMustExist: true });
    const integrity = sqlite.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      return [
        {
          name: "database",
          status: "problem",
          detail: `integrity_check failed: ${String(integrity)}`,
          fix: `stop the app and restore the newest copy from the backups folder next to ${file}`,
        },
      ];
    }
    const expected = expectedMigrations(migrationsDir);
    const applied = hasTable(sqlite, "__drizzle_migrations")
      ? z.object({ n: z.number() }).parse(sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).n
      : 0;
    const detail = `${file}, integrity ok, migrations applied ${applied} of ${expected}`;
    if (applied !== expected) {
      return [{ name: "database", status: "problem", detail, fix }];
    }
    return [{ name: "database", status: "ok", detail }, checkSession(sqlite), checkRecentErrors(sqlite)];
  } catch (error) {
    return [
      {
        name: "database",
        status: "problem",
        detail: `cannot read ${file}: ${message(error)}`,
        fix: `stop the app and restore the newest copy from the backups folder next to ${file}`,
      },
    ];
  } finally {
    sqlite?.close();
  }
}

function tail(file: string): string[] {
  const size = statSync(file).size;
  const length = Math.min(size, LOG_TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8").replace(/\n$/, "").split("\n").slice(-LOG_TAIL_LINES);
}

function checkLogs(dir: string): Check {
  const files = existsSync(dir)
    ? readdirSync(dir)
        .map((name) => join(dir, name))
        .filter((f) => statSync(f).isFile())
    : [];
  const newest = files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (newest === undefined) return { name: "log tail", status: "info", detail: `no log files in ${dir}` };
  return { name: "log tail", status: "info", detail: newest, lines: tail(newest) };
}

export function runDoctor(options: DoctorOptions): DoctorReport {
  const checks: Check[] = [
    checkNode(options.nodeVersion ?? process.versions.node),
    checkChrome(options.chromeApp ?? CHROME_APP),
    checkDataDir(options.paths),
    ...checkDatabase(options.paths.db, options.migrationsDir ?? MIGRATIONS_DIR),
    { name: "service", status: "info", detail: "auto-start: not installed (arrives in milestone 4)" },
    checkLogs(options.paths.logs),
  ];
  const problems = checks.filter((c) => c.status === "problem").length;
  return { checks, problems, ok: problems === 0 };
}

export function formatReport(report: DoctorReport): string {
  const out: string[] = [];
  for (const c of report.checks) {
    out.push(`${`[${c.status}]`.padEnd(10)}${c.name}: ${c.detail}`);
    if (c.fix !== undefined) out.push(`${" ".repeat(10)}fix: ${c.fix}`);
    for (const line of c.lines ?? []) out.push(`${" ".repeat(10)}| ${line}`);
  }
  out.push(report.ok ? "doctor: OK" : `doctor: PROBLEMS (${report.problems})`);
  return `${out.join("\n")}\n`;
}
