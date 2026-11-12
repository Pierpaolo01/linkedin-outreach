/**
 * The engine simulation against the real engine (handoff section 5, item 2): three seeds of the
 * three-week scenario, zero violations expected. Each seed runs in its own child process
 * (`scripts/simulate.ts --seed S`) so they run side by side: one seed spends nearly all its time
 * inside the engine's ticks. Three seeds match the three cores of a GitHub macOS runner; the
 * per-seed timeout leaves that slower machine several times what a seed takes on a laptop.
 * `npx tsx scripts/simulate.ts` runs 25 seeds.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/simulate.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SEEDS = [1, 2, 3];
const SEED_TIMEOUT_MS = 240_000;

function simulateSeed(seed: number): Promise<{ seed: number; code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, "--seed", String(seed)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => {
      output += `\nseed ${seed}: no result after ${SEED_TIMEOUT_MS / 1000} s; killed`;
      child.kill("SIGKILL");
    }, SEED_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ seed, code, output });
    });
  });
}

describe("engine simulation, real engine", () => {
  it(`${SEEDS.length} seeds of three weeks with kills, downtime and safety stops: no violation`, async () => {
    const runs = await Promise.all(SEEDS.map(simulateSeed));
    const failed = runs.filter((run) => run.code !== 0);
    expect(failed.map((run) => `--- seed ${run.seed} (exit ${String(run.code)})\n${run.output}`).join("\n")).toBe("");
  }, SEED_TIMEOUT_MS + 30_000);
});
