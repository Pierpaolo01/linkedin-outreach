import { chmodSync, closeSync, existsSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { dataPaths } from "../src/config/paths";
import { ensureDataDir } from "../src/db/index";
import { isPortListening } from "../src/ops/restore";
import {
  appServiceSpec,
  defaultServiceContext,
  installService,
  plistPath,
  privacyProtectedFolder,
  restartService,
  servicePlist,
  serviceStatus,
  stopService,
  uninstallService,
} from "../src/ops/service";

/**
 * `npm run service:install | service:uninstall | service:status | service:restart | service:stop`:
 * the launchd user agent that starts the app at login. `service:preflight` (used by `npm run update`)
 * fails when the app's port (PORT, default 4747) answers while the service has no process, that is
 * when the app runs in a terminal. Install resolves this repository's path and
 * the running Node binary's path now, so run it again after moving the repo or changing Node.
 */
const command = process.argv[2];
const repoDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const paths = dataPaths();
const ctx = defaultServiceContext();

function plist(): string {
  return servicePlist(
    appServiceSpec({
      label: ctx.label,
      repoDir,
      nodePath: process.execPath,
      logsDir: paths.logs,
      processEnv: process.env,
    }),
  );
}

function say(line: string): void {
  console.log(`service: ${line}`);
}

function fail(line: string): void {
  console.error(`service: FAILED: ${line}`);
  process.exitCode = 1;
}

/** The files launchd writes the app's output to, created private before launchd opens them. */
function prepareLogs(): void {
  ensureDataDir(paths);
  for (const name of ["service.out.log", "service.err.log"]) {
    const file = join(paths.logs, name);
    closeSync(openSync(file, "a", 0o600));
    chmodSync(file, 0o600);
  }
}

switch (command) {
  case "install": {
    const loader = join(repoDir, "node_modules", "tsx", "dist", "loader.mjs");
    if (!existsSync(loader)) {
      fail(`${loader} is missing; run \`npm run setup\` first`);
      break;
    }
    const folder = privacyProtectedFolder(repoDir);
    if (folder !== null) {
      fail(
        `the repository is in ${folder}, which macOS does not let a login item read, so the app would hang at start. Clone it somewhere else (for example \`git clone ${repoDir} ~/linkedin-outreach\`, then \`npm run setup\` there) and run \`npm run service:install\` from the new folder`,
      );
      break;
    }
    prepareLogs();
    const outcome = installService(ctx, plist());
    if (outcome.kind === "failed") fail(outcome.error);
    else
      say(
        outcome.kind === "installed"
          ? `installed and started (${outcome.plist}); the app now starts at login`
          : outcome.kind === "started"
            ? `already installed; the app was stopped and has been started (${outcome.plist})`
            : `already installed and running with the same settings (${outcome.plist})`,
      );
    break;
  }
  case "uninstall": {
    const outcome = uninstallService(ctx);
    if (outcome.kind === "failed") fail(outcome.error);
    else if (!outcome.unloaded && !outcome.removed) say("not installed; nothing to do");
    else say(`uninstalled (${outcome.unloaded ? "stopped and unloaded" : "was not loaded"}, plist ${outcome.removed ? "removed" : "was already gone"})`);
    break;
  }
  case "status": {
    const s = serviceStatus(ctx);
    say(`label ${ctx.label}, plist ${plistPath(ctx)}`);
    say(
      `installed ${s.installed ? "yes" : "no"}, loaded ${s.loaded ? "yes" : "no"}, running ${s.pid === null ? "no" : `yes (pid ${s.pid})`}, last exit ${s.lastExit ?? "none"}`,
    );
    break;
  }
  case "restart": {
    prepareLogs();
    const outcome = restartService(ctx, plist());
    if (outcome.kind === "failed") fail(outcome.error);
    else say(outcome.kind === "restarted" ? "restarted" : "not installed; nothing to restart");
    break;
  }
  case "stop": {
    const outcome = await stopService(ctx);
    if (outcome.kind === "failed") fail(outcome.error);
    else say(outcome.kind === "stopped" ? "stopped (it starts again at login or with `npm run service:restart`)" : "not running");
    break;
  }
  case "preflight": {
    const port = z.coerce.number().int().min(1).max(65_535).default(4747).parse(process.env["PORT"]);
    if ((await isPortListening(port)) && serviceStatus(ctx).pid === null) {
      fail(`something answers on port ${port} but the auto-start service is not running it: the app runs in a terminal`);
    }
    break;
  }
  default:
    console.error("usage: tsx scripts/service.ts install|uninstall|status|restart|stop|preflight");
    process.exitCode = 2;
}
