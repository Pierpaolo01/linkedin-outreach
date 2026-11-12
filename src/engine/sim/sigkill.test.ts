/**
 * A real crash, not a simulated one: a child Node process commits one ledger row, leaves a second
 * transaction open, and is killed with SIGKILL. The committed row must survive, the uncommitted one
 * must not, and the file must pass SQLite's integrity check.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../../db/index";

const CHILD = fileURLToPath(new URL("./sigkillChild.ts", import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SIGKILL in the middle of a transaction", () => {
  it("keeps the committed row, loses the uncommitted one, and leaves an intact database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "linkedin-sigkill-"));
    dirs.push(dir);
    const file = join(dir, "app.db");
    const child = spawn(process.execPath, ["--import", "tsx", CHILD, file], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
    await new Promise<void>((resolve, reject) => {
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes("ready")) resolve();
      });
      child.on("exit", (code) => reject(new Error(`child exited with ${String(code)} before it was ready: ${stderr}`)));
    });

    child.kill("SIGKILL");
    expect(await exited).toBe("SIGKILL");

    const reopened = openDb(file);
    try {
      const keys = reopened.sqlite
        .prepare("SELECT idempotency_key AS key FROM actions WHERE idempotency_key LIKE 'sigkill:%' ORDER BY id")
        .all()
        .map((row) => (row as { key: string }).key);
      expect(keys).toEqual(["sigkill:committed"]);
      expect(reopened.sqlite.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      reopened.close();
    }
  }, 30_000);
});
