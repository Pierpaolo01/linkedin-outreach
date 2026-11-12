/**
 * Backend 1 of spec section 8: the `claude` CLI in headless mode, on the user's own Claude login.
 *
 *   claude -p --output-format stream-json --verbose --tools "" --no-session-persistence --safe-mode
 *          --strict-mcp-config --system-prompt <static text> --json-schema <static schema> [--model M]
 *
 * The prompt (which holds LinkedIn data and the user's brief) goes on stdin, never in the arguments,
 * so it does not show in the process list. No tools, no session saved to disk, none of the user's
 * CLAUDE.md, hooks, plugins or MCP servers (`--safe-mode`, `--strict-mcp-config`), and a working
 * directory outside the repo. Flags checked against `claude --help` of Claude Code 2.1.322.
 *
 * `stream-json` rather than `json`: the final `result` line is the same object `json` prints, and the
 * `assistant` lines before it name the model that actually answered. The `result` line's usage totals
 * also list a small model the CLI runs on the side, so they cannot tell which one wrote the answer.
 */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { z } from "zod";
import type { AiProvider, Completion, CompletionRequest } from "./provider";
import { AiUnavailable } from "./types";

export interface ClaudeCliOptions {
  /** Empty or missing: the CLI's default model. */
  readonly model?: string | undefined;
  readonly binary?: string | undefined;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** More output than any answer should need; past this the child is stopped. */
const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

const envelopeSchema = z.object({
  type: z.literal("result"),
  subtype: z.string().optional(),
  is_error: z.boolean(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
});

type Envelope = z.infer<typeof envelopeSchema>;

const assistantSchema = z.object({ type: z.literal("assistant"), message: z.object({ model: z.string() }) });

const NOT_LOGGED_IN = /not logged in|please run \/login|invalid api key|authentication/i;

const LOGIN_ADVICE =
  "The claude CLI is not logged in. Open a terminal, run `claude`, log in with /login, then try again (or choose the Anthropic API in Settings).";

function snippet(text: string, length = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the binary with `input` on stdin. Rejects with `AiUnavailable` on spawn failure or timeout. */
function run(binary: string, args: readonly string[], input: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a timeout can kill anything the CLI started as well.
    const child = spawn(binary, args, { cwd, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const fail = (error: AiUnavailable) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(new AiUnavailable(`The claude CLI did not answer within ${Math.round(timeoutMs / 1000)} s and was stopped.`));
    }, timeoutMs);

    const collect = (into: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        fail(new AiUnavailable("The claude CLI printed far more than expected and was stopped."));
        return;
      }
      into.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));

    child.on("error", (error: NodeJS.ErrnoException) => {
      const message =
        error.code === "ENOENT"
          ? `The claude CLI was not found ("${binary}"). Install Claude Code and log in, or choose the Anthropic API in Settings.`
          : `The claude CLI could not be started: ${error.message}`;
      fail(new AiUnavailable(message, { cause: error }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });

    // The child may exit before reading stdin (a bad flag); that EPIPE is reported through its exit code.
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

interface Parsed {
  /** The final `result` line, or null when the output had none. */
  readonly envelope: Envelope | null;
  /** The model named on the last `assistant` line, if any. */
  readonly model: string | null;
}

function parseOutput(stdout: string): Parsed {
  let envelope: Envelope | null = null;
  let model: string | null = null;
  for (const line of stdout.split("\n")) {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue;
    }
    const result = envelopeSchema.safeParse(json);
    if (result.success) envelope = result.data;
    const assistant = assistantSchema.safeParse(json);
    if (assistant.success) model = assistant.data.message.model;
  }
  return { envelope, model };
}

export function createClaudeCli(options: ClaudeCliOptions = {}): AiProvider {
  const binary = options.binary ?? "claude";
  const cwd = options.cwd ?? tmpdir();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = options.model?.trim() ?? "";

  return {
    async complete(request: CompletionRequest): Promise<Completion> {
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--tools",
        "",
        "--no-session-persistence",
        "--safe-mode",
        "--strict-mcp-config",
        "--system-prompt",
        request.system,
        "--json-schema",
        JSON.stringify(request.schema),
        ...(model === "" ? [] : ["--model", model]),
      ];
      const { code, stdout, stderr } = await run(binary, args, request.prompt, cwd, timeoutMs);
      const { envelope, model: answeredBy } = parseOutput(stdout);

      if (envelope?.is_error === true || code !== 0) {
        const said = envelope?.result ?? envelope?.subtype ?? (stderr.trim() || stdout);
        if (NOT_LOGGED_IN.test(said) || NOT_LOGGED_IN.test(stderr)) throw new AiUnavailable(LOGIN_ADVICE);
        const exit = code === 0 ? "" : ` (exit code ${code ?? "none"})`;
        throw new AiUnavailable(`The claude CLI failed${exit}: ${snippet(said)}`);
      }
      if (envelope === null) {
        throw new AiUnavailable(`The claude CLI printed something that is not its JSON result: ${snippet(stdout, 200)}`);
      }

      const text = envelope.structured_output !== undefined ? JSON.stringify(envelope.structured_output) : (envelope.result ?? "");
      return { text, model: answeredBy ?? (model === "" ? "claude-cli" : model) };
    },
  };
}
