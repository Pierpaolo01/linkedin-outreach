/**
 * Runs the engine simulation (handoff section 5, item 2) against the real engine and prints the
 * report. Exit code 1 on any violation.
 *
 *   tsx scripts/simulate.ts [--seeds N] [--seed S] [--jobs J]
 *
 * `--seeds N` runs seeds S..S+N-1 (default 25); `--seed S` starts at S instead of 1 (with no
 * `--seeds`, it runs that one seed). `--jobs J` runs that many seeds at once, each in its own child
 * process (default 4); `--jobs 1` runs them one after another in this process. `--json` runs one
 * seed and prints its verdict as JSON: that is what each child does.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createEngine } from "../src/engine/engine";
import { resumeSafetyStop } from "../src/engine/safetyStop";
import { violationCount, type Verdict } from "../src/engine/sim/assertions";
import { formatReport, parseVerdict, runSeed } from "../src/engine/sim/report";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = fileURLToPath(new URL("../", import.meta.url));

const { values } = parseArgs({
  options: {
    seeds: { type: "string" },
    seed: { type: "string" },
    jobs: { type: "string", default: "4" },
    json: { type: "boolean", default: false },
  },
});

function whole(name: string, value: string | undefined, min: number): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) throw new RangeError(`--${name} needs a whole number from ${min}`);
  return parsed;
}

const first = whole("seed", values.seed, 0);
const count = whole("seeds", values.seeds, 1) ?? (first === null ? 25 : 1);
const jobs = whole("jobs", values.jobs, 1) ?? 4;
const start = first ?? 1;
const seeds = Array.from({ length: count }, (_, index) => start + index);
const engine = { createEngine, resumeSafetyStop };

interface Outcome {
  readonly seed: number;
  readonly verdict: Verdict | null;
  readonly elapsedMs: number;
  /** Why the child gave no verdict. */
  readonly failure: string | null;
}

/** One seed in a child process: `--seed S --json`, whose stdout is the verdict. */
function inChild(seed: number): Promise<Outcome> {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT, "--seed", String(seed), "--json"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ seed, verdict: null, elapsedMs: performance.now() - started, failure: error.message }));
    child.on("exit", (code) => {
      const elapsedMs = performance.now() - started;
      if (code !== 0) {
        resolve({ seed, verdict: null, elapsedMs, failure: `exit ${String(code)}: ${stderr.trim()}` });
        return;
      }
      try {
        resolve({ seed, verdict: parseVerdict(stdout), elapsedMs, failure: null });
      } catch (error) {
        resolve({ seed, verdict: null, elapsedMs, failure: `unreadable verdict: ${error instanceof Error ? error.message : String(error)}` });
      }
    });
  });
}

async function inProcess(seed: number): Promise<Outcome> {
  const started = performance.now();
  const verdict = await runSeed(engine, seed);
  return { seed, verdict, elapsedMs: performance.now() - started, failure: null };
}

function progress(outcome: Outcome): void {
  const what = outcome.verdict === null ? `failed (${outcome.failure ?? "?"})` : `${violationCount(outcome.verdict)} violation(s)`;
  process.stderr.write(`seed ${outcome.seed}: ${what}, ${(outcome.elapsedMs / 1000).toFixed(1)} s\n`);
}

/** Runs every seed, at most `jobs` at a time, and returns the outcomes in seed order. */
async function runAll(): Promise<Outcome[]> {
  const run = jobs === 1 || seeds.length === 1 ? inProcess : inChild;
  const outcomes: Outcome[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let seed = seeds[next++]; seed !== undefined; seed = seeds[next++]) {
      const outcome = await run(seed);
      progress(outcome);
      outcomes.push(outcome);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, seeds.length) }, worker));
  return outcomes.sort((a, b) => a.seed - b.seed);
}

if (values.json) {
  const verdict = await runSeed(engine, start);
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
} else {
  const started = performance.now();
  const outcomes = await runAll();
  const verdicts = outcomes.flatMap((outcome) => (outcome.verdict === null ? [] : [outcome.verdict]));
  const failed = outcomes.filter((outcome) => outcome.verdict === null);
  process.stdout.write(`${formatReport(verdicts)}\n`);
  for (const outcome of failed) process.stdout.write(`seed ${outcome.seed} gave no verdict: ${outcome.failure ?? "?"}\n`);
  process.stdout.write(
    `Time per seed: ${outcomes.map((outcome) => `${outcome.seed}: ${(outcome.elapsedMs / 1000).toFixed(1)} s`).join(", ")}\n` +
      `Wall clock: ${((performance.now() - started) / 1000).toFixed(1)} s for ${seeds.length} seed(s), ${Math.min(jobs, seeds.length)} at a time\n`,
  );
  process.exitCode = failed.length > 0 || verdicts.some((verdict) => violationCount(verdict) > 0) ? 1 : 0;
}
