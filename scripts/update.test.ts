import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * `scripts/update.sh` against a throwaway repository with a local bare remote: real git, and an
 * `npm` stand-in on PATH that records each call (no network, no install). NPM_FAIL makes the
 * call containing that word fail.
 */

const UPDATE_SH = fileURLToPath(new URL("./update.sh", import.meta.url));

let root: string;
let remote: string;
let work: string;
let dev: string;
let npmLog: string;
let fakeBin: string;

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
    env: { ...process.env, ...gitEnv, PATH: `${fakeBin}:${process.env["PATH"] ?? ""}`, NPM_LOG: npmLog, ...env },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

function npmCalls(): string[] {
  return existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n").filter(Boolean) : [];
}

const ALL_STEPS = [
  "run --silent service:preflight",
  "run --silent backup",
  "run --silent service:stop",
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
  fakeBin = join(root, "bin");
  mkdirSync(fakeBin);
  writeFileSync(
    join(fakeBin, "npm"),
    '#!/bin/sh\necho "$*" >> "$NPM_LOG"\ncase " $* " in *" $NPM_FAIL "*) echo "fake npm: $* failed" >&2; exit 1;; esac\nexit 0\n',
  );
  chmodSync(join(fakeBin, "npm"), 0o755);

  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "clone", "-q", remote, dev);
  git(dev, "checkout", "-q", "-b", "main");
  mkdirSync(join(dev, "scripts"));
  copyFileSync(UPDATE_SH, join(dev, "scripts", "update.sh"));
  commitFile(dev, "README.md", "v1\n", "v1");
  git(dev, "push", "-q", "-u", "origin", "main");
  git(root, "clone", "-q", remote, work);
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

  it("stops before the backup when the app is running outside the service", () => {
    const { code, out } = runUpdate({ NPM_FAIL: "service:preflight" });
    expect(code).toBe(1);
    expect(out).toMatch(/Nothing was changed/);
    expect(npmCalls()).toEqual(ALL_STEPS.slice(0, 1));
  });

  it("stops without pulling when the backup fails", () => {
    commitFile(dev, "README.md", "v2\n", "v2");
    git(dev, "push", "-q");
    const before = git(work, "rev-parse", "HEAD");

    const { code, out } = runUpdate({ NPM_FAIL: "backup" });

    expect(code).toBe(1);
    expect(out).toMatch(/backup/);
    expect(npmCalls()).toEqual(ALL_STEPS.slice(0, 2));
    expect(git(work, "rev-parse", "HEAD")).toBe(before);
  });

  it("stops at a failed install and runs nothing after it", () => {
    commitFile(dev, "README.md", "v2\n", "v2");
    git(dev, "push", "-q");

    const { code, out } = runUpdate({ NPM_FAIL: "ci" });

    expect(code).toBe(1);
    expect(out).toMatch(/npm ci/);
    expect(out).toMatch(/app is stopped/);
    expect(npmCalls()).toEqual(ALL_STEPS.slice(0, 4));
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
