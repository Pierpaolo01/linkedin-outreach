import { chmodSync, copyFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import type { DataPaths } from "../config/paths";
import { takeInstanceLock } from "../worker/instanceLock";
import { integrityOf } from "./backup";

/**
 * `npm run restore -- <file>`: puts a backup in place of `app.db` after copying
 * the current database aside. Refuses while the app is running, because the
 * app holds the database open and would keep writing to the replaced file.
 *
 * The app's instance lock (`app.lock`, decision 54) decides: an app on any port holds it while it
 * runs. The restore takes it for its whole run, so no app can open the database meanwhile, and
 * releases it when done, also when a step throws.
 */

export type RestoreOutcome =
  | { readonly kind: "restored"; readonly from: string; readonly aside: string | null }
  | { readonly kind: "refused"; readonly reason: string };

export interface RestoreOptions {
  readonly paths: Pick<DataPaths, "root" | "db" | "backups">;
  /** A file name in `backups/` (`app-2026-11-10.db`) or a path to a backup file. */
  readonly backup: string;
  readonly now: Date;
  /** An extra check beside `app.lock` (port, auto-start service); true means the restore changes nothing. */
  readonly isAppRunning: () => Promise<boolean>;
}

const SIDECARS = ["-wal", "-shm"] as const;

/** True when something accepts connections on 127.0.0.1:`port`. A connection that hangs counts as running. */
export function isPortListening(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((done) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (listening: boolean) => {
      socket.destroy();
      done(listening);
    };
    socket.setTimeout(timeoutMs, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function stamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "-");
}

function copyPrivate(from: string, to: string): void {
  copyFileSync(from, to);
  chmodSync(to, 0o600);
}

export async function restoreBackup(options: RestoreOptions): Promise<RestoreOutcome> {
  const { paths, backup } = options;
  const from = isAbsolute(backup) || backup.includes("/") ? resolve(backup) : join(paths.backups, backup);
  if (!existsSync(from) || !statSync(from).isFile()) {
    return { kind: "refused", reason: `no backup at ${from}. \`npm run doctor\` lists the backups` };
  }
  const lock = takeInstanceLock(paths.root);
  if (lock.kind === "held") {
    const who = lock.pid === null ? "another process" : `process ${lock.pid}`;
    return {
      kind: "refused",
      reason: `the app is running (${who} holds ${lock.path}). Stop it first (Ctrl+C in its terminal, or \`npm run service:stop\` if it starts at login), then run the restore again. If no copy of the app is running, delete ${lock.path}`,
    };
  }
  try {
    return await restoreHoldingLock(options, from);
  } finally {
    lock.release();
  }
}

async function restoreHoldingLock(options: RestoreOptions, from: string): Promise<RestoreOutcome> {
  const { paths, now } = options;
  // An extra check beside the lock: the port and the auto-start service.
  if (await options.isAppRunning()) {
    return {
      kind: "refused",
      reason:
        "the app is running. Stop it first (Ctrl+C in its terminal, or `npm run service:stop` if it starts at login), then run the restore again",
    };
  }
  const integrity = integrityOf(from);
  if (integrity !== "ok") {
    return { kind: "refused", reason: `${from} failed its integrity check (${integrity}); pick an older backup` };
  }

  // The current database, with any WAL files, copied byte for byte: kept even if it is damaged.
  let aside: string | null = null;
  if (existsSync(paths.db)) {
    aside = join(paths.root, `app.db.before-restore-${stamp(now)}`);
    copyPrivate(paths.db, aside);
    for (const suffix of SIDECARS) {
      if (existsSync(`${paths.db}${suffix}`)) copyPrivate(`${paths.db}${suffix}`, `${aside}${suffix}`);
    }
  }

  const incoming = `${paths.db}.restoring`;
  copyPrivate(from, incoming);
  // The old WAL belongs to the old database; replayed onto the backup it would corrupt it.
  for (const suffix of SIDECARS) rmSync(`${paths.db}${suffix}`, { force: true });
  renameSync(incoming, paths.db);
  return { kind: "restored", from, aside };
}
