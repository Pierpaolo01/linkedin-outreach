/**
 * One app per data directory (decision 54). The port is configurable, so a second app on another
 * port could otherwise tick the same database and send a step twice. `npm start` takes this lock
 * before it opens the database and holds it until it exits; a script that only reads (`doctor`)
 * does not take it.
 *
 * The lock is the file `app.lock` in the data directory, holding the process id. It is created in
 * one step (a hard link of a finished file), so it is never seen half written. A lock whose process
 * is no longer running is stale and is taken over. Known limit: two apps started in the same
 * instant over the same stale lock could both take it; the dedicated window's profile lock still
 * keeps the second one off LinkedIn.
 */
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOCK_FILE = "app.lock";

export type InstanceLock =
  | { readonly kind: "taken"; release(): void }
  /** `pid` is the holder's process id, or null when the file does not hold one. */
  | { readonly kind: "held"; readonly pid: number | null; readonly path: string };

/** True when a process with this id exists (one of another user counts too). */
export function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function holderOf(path: string): number | null | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  return /^[1-9]\d{0,9}$/.test(text) ? Number(text) : null;
}

function removeIfThere(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

const isExists = (error: unknown) => error instanceof Error && "code" in error && error.code === "EEXIST";

/**
 * Takes the lock in `dir`, or says who holds it. `pid` and `isRunning` are this process and the
 * system's answer by default.
 */
export function takeInstanceLock(
  dir: string,
  { pid = process.pid, isRunning = processIsRunning }: { readonly pid?: number; readonly isRunning?: (pid: number) => boolean } = {},
): InstanceLock {
  const path = join(dir, LOCK_FILE);
  const draft = join(dir, `${LOCK_FILE}.${pid}.${Date.now()}`);
  for (let attempt = 0; attempt < 3; attempt++) {
    writeFileSync(draft, String(pid), { mode: 0o600 });
    try {
      linkSync(draft, path);
    } catch (error) {
      if (!isExists(error)) throw error;
      const holder = holderOf(path);
      if (holder === undefined) continue; // released meanwhile: try again
      if (holder === null) return { kind: "held", pid: null, path };
      // A pid of its own is a lock left before a restart that gave this process the same id.
      if (holder !== pid && isRunning(holder)) return { kind: "held", pid: holder, path };
      removeIfThere(path);
      continue;
    } finally {
      removeIfThere(draft);
    }
    if (holderOf(path) !== pid) break;
    let released = false;
    return {
      kind: "taken",
      release() {
        if (released) return;
        released = true;
        if (holderOf(path) === pid) removeIfThere(path);
      },
    };
  }
  const holder = holderOf(path);
  return { kind: "held", pid: holder ?? null, path };
}
