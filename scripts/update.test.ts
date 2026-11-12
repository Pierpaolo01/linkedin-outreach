import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `scripts/update.sh` against a throwaway repository with a local bare remote: real git, and an
 * `npm` stand-in on PATH that records each call (no network, no install). NPM_FAIL makes the
 * call containing that word fail. Like the real one, the stand-in's `npm ci` first deletes
 * `node_modules`, and only a finished install leaves `node_modules/.package-lock.json`; without
 * `node_modules` its `npm run` fails, as tsx is gone.
 * A `launchctl` stand-in reports the auto-start service running with the pid in LAUNCHCTL_PID_FILE,
 * and `launchctl kill` stops it. The data directory is a temporary folder.
 */

const UPDATE_SH = fileURLToPath(new URL("./update.sh", import.meta.url));

let root: string;
let remote: string;
let work: string;
let dev: string;
let npmLog: string;
let launchctlLog: string;
let launchctlPidFile: string;
let fakeBin: string;
let data: string;

const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitEnv } }).trim();
}

function commitFile(repo: string, file: string, content: string, message: string): void {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
}

function runUpdate(env: Record<string, string> = {}) {
  const result = spawnSync("bash", [join(work, "scripts", "update.sh")], {
    cwd: work,
    encoding: "utf8",
    env: {
      ...process.env,
      ...gitEnv,
      PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`,
      NPM_LOG: npmLog,
      LAUNCHCTL_LOG: launchctlLog,
      LAUNCHCTL_PID_FILE: launchctlPidFile,
      LINKEDIN_OUTREACH_DATA_DIR: data,
      ...env,
    },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function lines(file: string): string[] {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
}
const npmCalls = () => lines(npmLog);

/** A process id that no running process has. */
const exitedPid = () => spawnSync(process.execPath, ["-e", ""]).pid;

const ALL_STEPS = [
  "run --silent backup",
  "ci --no-audit --no-fund --loglevel=error",
  "run --silent migrate",
  "run --silent build:ui",
  "run --silent service:restart",
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lo-update-"));
  remote = join(root, "remote.git");
  work = join(root, "work");
  dev = join(root, "dev");
  npmLog = join(root, "npm.log");
  launchctlLog = join(root, "launchctl.log");
  launchctlPidFile = join(root, "service.pid");
  fakeBin = join(root, "bin");
  data = join(root, "data");
  mkdirSync(fakeBin);
  mkdirSync(data);
  writeFileSync(join(data, "app.db"), "the database");
  writeFileSync(
    join(fakeBin, "npm"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$NPM_LOG"',
      // Every package script runs through tsx, which lives in node_modules.
      'if [ "$1" = run ] && [ ! -d node_modules ]; then echo "sh: tsx: command not found" >&2; exit 127; fi',
      'if [ "$1" = ci ]; then rm -rf node_modules; fi',
      'case " $* " in *" $NPM_FAIL "*) echo "fake npm: $* failed" >&2; exit 1;; esac',
      'if [ "$1" = ci ]; then mkdir -p node_modules && : > node_modules/.package-lock.json; fi',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(fakeBin, "npm"), 0o755);
  writeFileSync(
    join(fakeBin, "launchctl"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$LAUNCHCTL_LOG"',
      'case "$1" in',
      '  print) if [ -f "$LAUNCHCTL_PID_FILE" ]; then printf \'\\tpid = %s\\n\' "$(cat "$LAUNCHCTL_PID_FILE")"; exit 0; fi',
      '         echo "Could not find service" >&2; exit 113;;',
      '  kill) rm -f "$LAUNCHCTL_PID_FILE"; exit 0;;',
      "esac",
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(join(fakeBin, "launchctl"), 0o755);

  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", remote, dev);
  git(dev, "checkout", "-q", "-b", "main");
  mkdirSync(join(dev, "scripts"));
  copyFileSync(UPDATE_SH, join(dev, "scripts", "update.sh"));
  commitFile(dev, "README.md", "v1\n", "v1");
  git(dev, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", remote, work);
  // An installed checkout: dependencies from a finished install.
  mkdirSync(join(work, "node_modules"));
  writeFileSync(join(work, "node_modules", ".package-lock.json"), "{}");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("update.sh", () => {
  it("backs up, pulls, installs, migrates, builds and restarts, in that order", () => {
    commitFile(dev, "README.md", "v2\n", "v2");
    git(dev, "push", "-q");

    const { code, out } = runUpdate();

    expect(out).toContain("update: done");
    expect(code).toBe(0);
    expect(git(work, "rev-parse", "HEAD")).toBe(git(dev, "rev-parse", "HEAD"));
    expect(npmCalls()).toEqual(ALL_STEPS);
  });

  it("still runs every step when already up to date", () => {
    const { code } = runUpdate();
    expect(code).toBe(0);
    expect(npmCalls()).toEqual(ALL_STEPS);
  });

  it("stops before changing anything when the working tree has local changes", () => {
    commitFile(dev, "README.md", "v2\n", "v2");
    git(dev, "push", "-q");
    const before = git(work, "rev-parse", "HEAD");
    writeFileSync(join(work, "README.md"), "edited by hand\n");

    const { code, out } = runUpdate();

    expect(code).toBe(1);
    expect(out).toMatch(/local changes/);
    expect(out).toMatch(/Nothing was changed/);
    expect(npmCalls()).toEqual([]);
    expect(git(work, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(work, "README.md"), "utf8")).toBe("edited by hand\n");
  });

  it("stops before changing anything when the pull would not be a fast-forward", () => {
    commitFile(dev, "README.md", "v2\n", "v2");
    git(dev, "push", "-q");
    commitFile(work, "local.txt", "mine\n", "a local commit");
    const before = git(work, "rev-parse", "HEAD");

    const { code, out } = runUpdate();

    expect(code).toBe(1);
    expect(out).toMatch(/fast-forward/);
    expect(out).toMatch(/Nothing was changed/);
    expect(npmCalls()).toEqual([]);
    expect(git(work, "rev-parse", "HEAD")).toBe(before);
  });

  it("stops when the branch has no upstream", () => {
    git(work, "checkout", "-q", "-b", "elsewhere");
    const { code, out } = runUpdate();
    expect(code).toBe(1);
    expect(out).toMatch(/upstream/);
    expect(npmCalls()).toEqual([]);
  });

  it("stops before the backup when a process other than the service holds app.lock", () => {
    writeFileSync(join(data, "app.lock"), String(process.pid));

    const { code, out } = runUpdate();

    expect(code).toBe(1);
    expect(out).toMatch(/outside the auto-start service/);
    expect(out).toContain(`process ${process.pid}`);
    expect(out).toMatch(/Nothing was changed/);
    expect(npmCalls()).toEqual([]);
  });

  it("goes ahead when the auto-start service holds app.lock, and stops it before installing", () => {
    writeFileSync(join(data, "app.lock"), String(process.pid));
    writeFileSync(launchctlPidFile, String(process.pid));

    const { code, out } = runUpdate();

    expect(out).toContain("update: done");
    expect(code).toBe(0);
    expect(npmCalls()).toEqual(ALL_STEPS);
    expect(lines(launchctlLog)).toContain(`kill SIGTERM gui/${userInfo().uid}/com.linkedin-outreach.app`);
  });

  it("goes ahead over a stale app.lock", () => {
    writeFileSync(join(data, "app.lock"), String(exitedPid()));
    const { code } = runUpdate();
    expect(code).toBe(0);
    expect(npmCalls()).toEqual(ALL_STEPS);
  });

  it("after an npm ci that failed and left no node_modules, a second run installs again and finishes", () => {
    commitFile(dev, "README.md", "v2\n", "v2");
    git(dev, "push", "-q");
    writeFileSync(join(data, "app.db-wal"), "the database's WAL");

    const first = runUpdate({ NPM_FAIL: "ci" });
    expect(first.code).toBe(1);
    expect(first.out).toMatch(/npm ci failed/);
    expect(existsSync(join(work, "node_modules"))).toBe(false);

    rmSync(npmLog);
    const second = runUpdate();

    expect(second.out).not.toMatch(/outside the auto-start service/);
    expect(second.out).toContain("update: done");
    expect(second.code).toBe(0);
    // No packaged backup without node_modules: the database is copied aside with cp instead.
    expect(npmCalls()).toEqual(ALL_STEPS.slice(1));
    const aside = readdirSync(data).filter((name) => name.startsWith("app.db.before-update-"));
    expect(aside).toHaveLength(2);
    const db = aside.find((name) => !name.endsWith("-wal")) ?? "";
    expect(readFileSync(join(data, db), "utf8")).toBe("the database");
    expect(readFileSync(join(data, `${db}-wal`), "utf8")).toBe("the database's WAL");
    expect(existsSync(join(work, "node_modules", ".package-lock.json"))).toBe(true);
    expect(git(work, "rev-parse", "HEAD")).toBe(git(dev, "rev-parse", "HEAD"));
  });

  it("stops without pulling when the backup fails", () => {
    commitFile(dev, "README.md", "v2\n", "v2");
    git(dev, "push", "-q");
    const before = git(work, "rev-parse", "HEAD");

    const { code, out } = runUpdate({ NPM_FAIL: "backup" });

    expect(code).toBe(1);
    expect(out).toMatch(/backup/);
    expect(npmCalls()).toEqual(ALL_STEPS.slice(0, 1));
    expect(git(work, "rev-parse", "HEAD")).toBe(before);
  });

  it("stops at a failed install and runs nothing after it", () => {
    commitFile(dev, "README.md", "v2\n", "v2");
    git(dev, "push", "-q");

    const { code, out } = runUpdate({ NPM_FAIL: "ci" });

    expect(code).toBe(1);
    expect(out).toMatch(/npm ci/);
    expect(out).toMatch(/app is stopped/);
    expect(npmCalls()).toEqual(ALL_STEPS.slice(0, 2));
  });

  it("finishes correctly when the pull rewrites update.sh itself", () => {
    const original = readFileSync(join(dev, "scripts", "update.sh"), "utf8");
    const [shebang, ...rest] = original.split("\n");
    const padding = Array.from({ length: 200 }, (_, i) => `# padding line ${i} that moves every byte of the old script`);
    commitFile(dev, "scripts/update.sh", [shebang, ...padding, ...rest].join("\n"), "a longer update.sh");
    git(dev, "push", "-q");

    const { code, out } = runUpdate();

    expect(out).not.toMatch(/command not found|syntax error/);
    expect(code).toBe(0);
    expect(npmCalls()).toEqual(ALL_STEPS);
  });
});
