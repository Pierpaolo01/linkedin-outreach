import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudeCli } from "./claudeCli";
import { AiUnavailable } from "./types";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "claude-cli-test-")));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes an executable shell script standing in for `claude` and returns its path. */
function fakeClaude(body: string): string {
  const file = join(dir, "claude");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const REQUEST = {
  system: "You answer with JSON only.",
  prompt: "Secret prompt about Anna Verdi",
  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
};

function envelope(fields: Record<string, unknown>): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, ...fields });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("claudeCli", () => {
  it("sends the prompt on stdin from a fixed directory and returns the structured output with the model", async () => {
    // The usage totals list a side model with more output; the assistant line names the one that answered.
    const out = [
      JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5-5" }),
      JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", content: [] } }),
      envelope({
        result: '{"ok":true}',
        structured_output: { ok: true },
        modelUsage: { "claude-haiku-5-5": { outputTokens: 900 }, "claude-opus-5-5": { outputTokens: 73 } },
      }),
    ].join("\n");
    const binary = fakeClaude(
      `pwd > "${dir}/cwd"\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${dir}/args"\ncat > "${dir}/stdin"\necho '${out}'`,
    );
    const workDir = mkdtempSync(join(dir, "work-"));
    const completion = await createClaudeCli({ binary, cwd: workDir }).complete(REQUEST);

    expect(completion).toEqual({ text: '{"ok":true}', model: "claude-opus-5-5" });
    expect(readFileSync(join(dir, "stdin"), "utf8")).toBe(REQUEST.prompt);
    expect(readFileSync(join(dir, "cwd"), "utf8").trim()).toBe(realpathSync(workDir));
    const args = readFileSync(join(dir, "args"), "utf8").split("\n");
    expect(args).toContain("-p");
    expect(args.join(" ")).toContain("--output-format stream-json --verbose");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--safe-mode");
    expect(args).toContain(JSON.stringify(REQUEST.schema));
    expect(args.join(" ")).not.toContain("Anna Verdi");
    expect(args).not.toContain("--model");
  });

  it("passes the configured model and falls back to the result text", async () => {
    const binary = fakeClaude(
      `for a in "$@"; do printf '%s\\n' "$a"; done > "${dir}/args"\ncat > /dev/null\necho '${envelope({ result: '{"ok":false}' })}'`,
    );
    const completion = await createClaudeCli({ binary, cwd: dir, model: "sonnet" }).complete(REQUEST);
    expect(completion).toEqual({ text: '{"ok":false}', model: "sonnet" });
    expect(readFileSync(join(dir, "args"), "utf8")).toContain("--model\nsonnet\n");
  });

  it("is unavailable when the CLI prints something that is not its JSON result", async () => {
    const binary = fakeClaude("cat > /dev/null\necho 'Welcome to Claude Code!'");
    await expect(createClaudeCli({ binary, cwd: dir }).complete(REQUEST)).rejects.toThrow(/not its JSON result/);
  });

  it("is unavailable on a non-zero exit, with what the CLI said", async () => {
    const binary = fakeClaude("cat > /dev/null\necho 'unknown option --safe-mode' >&2\nexit 2");
    const error = await createClaudeCli({ binary, cwd: dir }).complete(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiUnavailable);
    expect((error as Error).message).toMatch(/exit code 2/);
    expect((error as Error).message).toMatch(/unknown option --safe-mode/);
  });

  it("tells the user to log in when the CLI is not logged in", async () => {
    const out = envelope({ is_error: true, subtype: "error", result: "Not logged in · Please run /login" });
    const binary = fakeClaude(`cat > /dev/null\necho '${out}'\nexit 1`);
    await expect(createClaudeCli({ binary, cwd: dir }).complete(REQUEST)).rejects.toThrow(/not logged in.*run `claude`/i);
  });

  it("is unavailable when the CLI reports an error in its result", async () => {
    const out = envelope({ is_error: true, subtype: "error_during_execution", result: "API Error: 529 overloaded" });
    const binary = fakeClaude(`cat > /dev/null\necho '${out}'`);
    await expect(createClaudeCli({ binary, cwd: dir }).complete(REQUEST)).rejects.toThrow(/529 overloaded/);
  });

  it("kills a CLI that hangs past the timeout", async () => {
    const binary = fakeClaude(`echo $$ > "${dir}/pid"\nsleep 30 & echo $! > "${dir}/child"\nwait`);
    const started = Date.now();
    await expect(createClaudeCli({ binary, cwd: dir, timeoutMs: 1_500 }).complete(REQUEST)).rejects.toThrow(/did not answer within/);
    expect(Date.now() - started).toBeLessThan(5_000);

    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    const child = Number(readFileSync(join(dir, "child"), "utf8"));
    await expect.poll(() => isAlive(pid)).toBe(false);
    await expect.poll(() => isAlive(child)).toBe(false);
  });

  it("is unavailable with install advice when the binary is missing", async () => {
    const cli = createClaudeCli({ binary: join(dir, "no-such-claude"), cwd: dir });
    const error = await cli.complete(REQUEST).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiUnavailable);
    expect((error as Error).message).toMatch(/not found.*Install Claude Code/);
  });
});
