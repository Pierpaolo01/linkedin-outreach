import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCK_FILE, takeInstanceLock } from "./instanceLock";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lo-lock-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lockFile = () => join(dir, LOCK_FILE);
const running = (pids: readonly number[]) => (pid: number) => pids.includes(pid);

describe("takeInstanceLock", () => {
  it("takes the lock in the data directory with the process id, and releases it", () => {
    const lock = takeInstanceLock(dir, { pid: 101, isRunning: running([101]) });

    expect(lock.kind).toBe("taken");
    expect(readFileSync(lockFile(), "utf8")).toBe("101");
    if (lock.kind === "taken") lock.release();
    expect(existsSync(lockFile())).toBe(false);
  });

  it("refuses while another live process holds it, and says which one", () => {
    const first = takeInstanceLock(dir, { pid: 101, isRunning: running([101, 202]) });
    const second = takeInstanceLock(dir, { pid: 202, isRunning: running([101, 202]) });

    expect(first.kind).toBe("taken");
    expect(second).toEqual({ kind: "held", pid: 101, path: lockFile() });
    expect(readFileSync(lockFile(), "utf8")).toBe("101");
  });

  it("takes over a lock whose process is no longer running", () => {
    writeFileSync(lockFile(), "303");

    const lock = takeInstanceLock(dir, { pid: 101, isRunning: running([101]) });

    expect(lock.kind).toBe("taken");
    expect(readFileSync(lockFile(), "utf8")).toBe("101");
  });

  it("takes over a lock left with its own process id (a pid used again after a restart)", () => {
    writeFileSync(lockFile(), "101");
    expect(takeInstanceLock(dir, { pid: 101, isRunning: running([101]) }).kind).toBe("taken");
  });

  it("refuses a lock it cannot read rather than guessing it is stale", () => {
    writeFileSync(lockFile(), "not a pid");
    expect(takeInstanceLock(dir, { pid: 101, isRunning: running([101]) })).toEqual({ kind: "held", pid: null, path: lockFile() });
    expect(readFileSync(lockFile(), "utf8")).toBe("not a pid");
  });

  it("release leaves alone a lock another process has taken since", () => {
    const lock = takeInstanceLock(dir, { pid: 101, isRunning: running([101]) });
    writeFileSync(lockFile(), "202");
    if (lock.kind === "taken") lock.release();
    expect(readFileSync(lockFile(), "utf8")).toBe("202");
  });

  it("asks the system whether a process runs: this one does, one that has exited does not", () => {
    writeFileSync(lockFile(), String(process.pid));
    expect(takeInstanceLock(dir, { pid: process.pid + 1 })).toMatchObject({ kind: "held", pid: process.pid });

    const exited = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(lockFile(), String(exited));
    expect(takeInstanceLock(dir).kind).toBe("taken");
  });
});

describe("npm start (src/main.ts)", () => {
  const ROOT = fileURLToPath(new URL("../..", import.meta.url));
  /** Node itself with tsx loaded, so a signal reaches the app and not a wrapper process. */
  const NODE = [process.execPath, ["--import", "tsx", "src/main.ts"]] as const;

  /** Runs the app with the fake LinkedIn and no engine, in a home folder of its own; it must exit by itself. */
  function start(env: Record<string, string | undefined>) {
    const home = mkdtempSync(join(tmpdir(), "lo-home-"));
    const base: Record<string, string | undefined> = { ...process.env, HOME: home, LINKEDIN_DRIVER: "fake", ENGINE: "off", NO_OPEN: "1", PORT: "47391" };
    delete base["LINKEDIN_OUTREACH_DATA_DIR"];
    const result = spawnSync(NODE[0], NODE[1], { cwd: ROOT, env: { ...base, ...env }, encoding: "utf8", timeout: 30_000 });
    return { ...result, home };
  }

  it("exits with an error, without opening the database, while another live app holds the lock", { timeout: 40_000 }, () => {
    writeFileSync(lockFile(), String(process.pid));

    const result = start({ LINKEDIN_OUTREACH_DATA_DIR: dir });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`process ${process.pid}`);
    expect(existsSync(join(dir, "app.db"))).toBe(false);
    expect(readFileSync(lockFile(), "utf8")).toBe(String(process.pid));
    rmSync(result.home, { recursive: true, force: true });
  });

  it("holds the lock while it runs and removes it when stopped", { timeout: 40_000 }, async () => {
    const home = mkdtempSync(join(tmpdir(), "lo-home-"));
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, LINKEDIN_DRIVER: "fake", ENGINE: "off", NO_OPEN: "1", PORT: "47392", LINKEDIN_OUTREACH_DATA_DIR: dir };
    const child = spawn(NODE[0], NODE[1], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => {
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          if (out.includes("is running at")) resolve();
        });
        child.on("exit", (code) => reject(new Error(`the app exited (${String(code)}) before it ran`)));
      });
      expect(readFileSync(lockFile(), "utf8")).toBe(String(child.pid));
      // One request answered: the app has run past start-up and handles SIGTERM itself.
      expect((await fetch("http://127.0.0.1:47392/api/health")).status).toBe(200);
      const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect(existsSync(lockFile())).toBe(false);
    } finally {
      child.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("with the fake LinkedIn refuses the default data directory and says to use a scratch folder", { timeout: 40_000 }, () => {
    const result = start({});

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Set LINKEDIN_OUTREACH_DATA_DIR to a scratch folder");
    expect(existsSync(join(result.home, "Library"))).toBe(false);
    rmSync(result.home, { recursive: true, force: true });
  });
});
