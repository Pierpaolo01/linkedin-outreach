/**
 * Routes for the Settings screen's operations: backups, auto-start, keep-awake and the AI test.
 * Everything that touches the system (launchctl, the AI, the clock, the backup itself) is passed
 * in, so tests never spawn a process or call a real AI.
 */
import { basename } from "node:path";
import type { FastifyInstance } from "fastify";
import { runAiSelfTest, SELF_TEST_CARDS, SELF_TEST_NAME } from "../ai/selfTest";
import type { Ai } from "../ai/types";
import type { DataPaths } from "../config/paths";
import { getSettings, type Settings } from "../config/settings";
import type { Db } from "../db/index";
import { listBackups, type BackupOutcome } from "../ops/backup";
import type { Logger } from "../ops/log";
import { privacyProtectedFolder, type ServiceStatus } from "../ops/service";
import { NO_BODY_ERROR, noBody } from "./http";

export interface OpsDeps {
  /** `root` is shown as the data folder; backups are listed from `backups`. */
  readonly paths: Pick<DataPaths, "root" | "backups">;
  /** A backup now, replacing today's (`backupNow` on the open database). */
  readonly backupNow: () => Promise<BackupOutcome>;
  /** The launchd job's state (`serviceStatus` with launchctl). */
  readonly serviceStatus: () => ServiceStatus;
  /** The repository the app runs from: auto-start cannot run it from a folder macOS protects. */
  readonly repoDir: string;
  /** The user's home folder. Default: the real one. */
  readonly home?: string;
  /** True while the app holds `caffeinate`. */
  readonly keepAwakeActive: () => boolean;
  /** Builds the AI for the provider in Settings (`createAi`). */
  readonly createAi: (settings: Settings["ai"]) => Ai;
  /** Milliseconds from a monotonic clock, for `elapsedMs`. Default `performance.now`. */
  readonly monotonic?: () => number;
  /** The app's file log. Default: nothing. */
  readonly log?: Logger;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
}

function serviceJson(deps: OpsDeps) {
  const folder = privacyProtectedFolder(deps.repoDir, ...(deps.home === undefined ? [] : [deps.home]));
  let status: ServiceStatus;
  try {
    status = deps.serviceStatus();
  } catch (error) {
    return { installed: false, loaded: false, running: false, note: `Could not read the auto-start state (${messageOf(error)}).` };
  }
  const running = status.pid !== null;
  let note: string | null = null;
  if (folder !== null && !status.installed) {
    note = `Auto-start cannot be installed from this folder: the app is in ${folder}, which macOS does not let a login item read. Move or clone the app folder somewhere else (for example your home folder), run \`npm run setup\` there, then \`npm run service:install\`.`;
  } else if (!status.installed) {
    note = "Auto-start is off. To start the app at login, run `npm run service:install` in the app folder.";
  } else if (!status.loaded) {
    note = "Auto-start is installed but not loaded. Run `npm run service:install` again in the app folder.";
  }
  return { installed: status.installed, loaded: status.loaded, running, note };
}

function backupJson(outcome: BackupOutcome) {
  switch (outcome.kind) {
    case "created":
    case "skipped":
      return { kind: outcome.kind, file: basename(outcome.file) };
    case "failed":
      return { kind: "failed", message: `The backup failed: ${outcome.error}` } as const;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

const AI_HINT: Readonly<Record<Settings["ai"]["provider"], string>> = {
  claude_cli: "Check that Claude Code is installed and signed in (run `claude` in Terminal once), or choose the Anthropic API in Settings.",
  anthropic_api: "Check the API key in secrets.json in the data folder and the model name, or choose the claude CLI in Settings.",
};

/** The error as the user reads it, with what to check when the error itself does not say. */
function aiFailure(provider: Settings["ai"]["provider"], error: unknown): string {
  const text = messageOf(error);
  const cause = error instanceof Error && error.cause !== undefined ? messageOf(error.cause) : "";
  const said = cause !== "" && !text.includes(cause) ? `${text} (${cause})` : text;
  const advises = /Settings|secrets\.json|log in|logged in|signed in/i.test(said);
  if (error instanceof Error && error.name === "AiUnavailable" && advises) return said;
  return `The AI test failed: ${said.replace(/\.$/, "")}. ${AI_HINT[provider]}`;
}

export function registerOpsRoutes(app: FastifyInstance, deps: OpsDeps & { readonly db: Db }): void {
  const { db, log } = deps;
  const monotonic = deps.monotonic ?? (() => performance.now());

  app.get("/api/ops", async () => ({
    backups: listBackups(deps.paths).map((b) => ({ file: b.name, date: b.date, sizeBytes: b.bytes })),
    service: serviceJson(deps),
    keepAwake: { enabled: getSettings(db).keepAwake, active: deps.keepAwakeActive() },
    dataDir: deps.paths.root,
  }));

  app.post("/api/ops/backup", async (request, reply) => {
    if (!noBody.safeParse(request.body).success) return reply.code(400).send(NO_BODY_ERROR);
    let outcome: BackupOutcome;
    try {
      outcome = await deps.backupNow();
    } catch (error) {
      outcome = { kind: "failed", error: messageOf(error) };
    }
    if (outcome.kind === "failed") log?.error("backup failed", { trigger: "dashboard", error: outcome.error });
    else log?.info(`backup ${outcome.kind}`, { trigger: "dashboard", file: basename(outcome.file) });
    return reply.send(backupJson(outcome));
  });

  let aiTestRunning = false;
  app.post("/api/ai/test", async (request, reply) => {
    if (!noBody.safeParse(request.body).success) return reply.code(400).send(NO_BODY_ERROR);
    if (aiTestRunning) return reply.code(409).send({ error: "An AI test is already running" });
    aiTestRunning = true;
    try {
      const settings = getSettings(db).ai;
      const started = monotonic();
      let body: { ok: boolean; provider: string; model: string | null; elapsedMs: number; message: string };
      try {
        const result = await runAiSelfTest(deps.createAi(settings));
        const elapsedMs = Math.round(monotonic() - started);
        const first = result.cleaned.value.firstName ?? "no first name";
        const scores = SELF_TEST_CARDS.map((card) => result.scored.value.find((s) => s.publicId === card.publicId)?.score ?? "?");
        body = {
          ok: true,
          provider: settings.provider,
          model: result.cleaned.model,
          elapsedMs,
          message: `The AI answered in ${(elapsedMs / 1000).toFixed(1)} s: it read "${first}" from "${SELF_TEST_NAME.fullName}" and scored the two test cards ${scores.join(" and ")} out of 10.`,
        };
      } catch (error) {
        body = {
          ok: false,
          provider: settings.provider,
          model: settings.model === "" ? null : settings.model,
          elapsedMs: Math.round(monotonic() - started),
          message: aiFailure(settings.provider, error),
        };
      }
      log?.[body.ok ? "info" : "warn"]("ai test", { ok: body.ok, provider: body.provider, elapsedMs: body.elapsedMs });
      return reply.send(body);
    } finally {
      aiTestRunning = false;
    }
  });
}
