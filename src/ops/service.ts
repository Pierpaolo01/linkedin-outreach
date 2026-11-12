import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Auto-start at login (spec section 11): a launchd user agent that runs the
 * app from this repository with the Node binary found at install time.
 * Restarted by launchd only after a crash, at most every 30 seconds; a clean
 * exit (SIGTERM, Ctrl+C) stays stopped.
 */

export const SERVICE_LABEL = "com.linkedin-outreach.app";
const THROTTLE_SECONDS = 30;
/** 077: files the app creates are readable by the user only. */
const UMASK = 0o077;

export interface ServiceSpec {
  readonly label: string;
  /** Absolute path of the node binary. */
  readonly nodePath: string;
  /** Absolute path of the repository. */
  readonly repoDir: string;
  /** The data directory's `logs/`. */
  readonly logsDir: string;
  /** Environment for the app, in this order. */
  readonly env: Readonly<Record<string, string>>;
}

export type LaunchctlResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
export type Launchctl = (args: readonly string[]) => LaunchctlResult;

export interface ServiceContext {
  readonly label: string;
  readonly launchAgentsDir: string;
  readonly uid: number;
  readonly launchctl: Launchctl;
}

export interface ServiceStatus {
  /** The plist is in LaunchAgents. */
  readonly installed: boolean;
  /** launchd knows the job (it will start it at login). */
  readonly loaded: boolean;
  readonly pid: number | null;
  /** "exit code N" or "signal ...", null when it never exited. */
  readonly lastExit: string | null;
}

export type InstallOutcome =
  | { readonly kind: "installed"; readonly plist: string }
  | { readonly kind: "unchanged"; readonly plist: string }
  | { readonly kind: "started"; readonly plist: string }
  | { readonly kind: "failed"; readonly error: string };

export type UninstallOutcome =
  | { readonly kind: "uninstalled"; readonly unloaded: boolean; readonly removed: boolean }
  | { readonly kind: "failed"; readonly error: string };

export type RestartOutcome =
  | { readonly kind: "restarted" }
  | { readonly kind: "not_installed" }
  | { readonly kind: "failed"; readonly error: string };

export type StopOutcome =
  | { readonly kind: "stopped" }
  | { readonly kind: "not_running" }
  | { readonly kind: "failed"; readonly error: string };

export const systemLaunchctl: Launchctl = (args) => {
  const result = spawnSync("launchctl", [...args], { encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr || (result.error?.message ?? "") };
};

export function defaultServiceContext(label: string = SERVICE_LABEL): ServiceContext {
  return {
    label,
    launchAgentsDir: join(homedir(), "Library", "LaunchAgents"),
    uid: userInfo().uid,
    launchctl: systemLaunchctl,
  };
}

function xml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const str = (text: string) => `<string>${xml(text)}</string>`;

export function servicePlist(spec: ServiceSpec): string {
  const program = [
    spec.nodePath,
    "--import",
    pathToFileURL(join(spec.repoDir, "node_modules", "tsx", "dist", "loader.mjs")).href,
    join(spec.repoDir, "src", "main.ts"),
  ];
  const env = Object.entries(spec.env).flatMap(([key, value]) => [`    <key>${xml(key)}</key>`, `    ${str(value)}`]);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  ${str(spec.label)}`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...program.map((arg) => `    ${str(arg)}`),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  ${str(spec.repoDir)}`,
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    `  <integer>${THROTTLE_SECONDS}</integer>`,
    "  <key>Umask</key>",
    `  <integer>${UMASK}</integer>`,
    "  <key>StandardOutPath</key>",
    `  ${str(join(spec.logsDir, "service.out.log"))}`,
    "  <key>StandardErrorPath</key>",
    `  ${str(join(spec.logsDir, "service.err.log"))}`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...env,
    "  </dict>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

const PROTECTED_FOLDERS: readonly (readonly [string, string])[] = [
  ["Documents", "~/Documents"],
  ["Desktop", "~/Desktop"],
  ["Downloads", "~/Downloads"],
  [join("Library", "Mobile Documents"), "iCloud Drive"],
];

/**
 * The privacy-protected folder `repoDir` is in, or null. macOS refuses a launchd job read access
 * to these folders unless Node has been given it by hand; Node then hangs at start instead of
 * failing (seen 2026-11-12: `head` from a launchd job got "Operation not permitted" on
 * ~/Documents, and the app never opened its port).
 */
export function privacyProtectedFolder(repoDir: string, home: string = homedir()): string | null {
  for (const [folder, name] of PROTECTED_FOLDERS) {
    const rel = relative(join(home, folder), repoDir);
    if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) return name;
  }
  return null;
}

const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * The app's launchd job: NO_OPEN=1, a PATH led by node's own folder (launchd's default PATH has
 * no node, and the `claude` CLI is found through it), and the data directory when it is not the
 * default. Nothing else from the installing shell is copied.
 */
export function appServiceSpec(input: {
  readonly label: string;
  readonly repoDir: string;
  readonly nodePath: string;
  readonly logsDir: string;
  readonly processEnv: Readonly<Record<string, string | undefined>>;
  readonly extraEnv?: Readonly<Record<string, string>>;
}): ServiceSpec {
  const inherited = (input.processEnv["PATH"] ?? "").split(":").filter((p) => p !== "" && !p.includes("/node_modules/"));
  const path = [...new Set([dirname(input.nodePath), ...(inherited.length > 0 ? inherited : SYSTEM_PATH)])].join(":");
  const dataDir = input.processEnv["LINKEDIN_OUTREACH_DATA_DIR"];
  return {
    label: input.label,
    nodePath: input.nodePath,
    repoDir: input.repoDir,
    logsDir: input.logsDir,
    env: {
      NO_OPEN: "1",
      PATH: path,
      ...(dataDir === undefined ? {} : { LINKEDIN_OUTREACH_DATA_DIR: dataDir }),
      ...input.extraEnv,
    },
  };
}

export function plistPath(ctx: ServiceContext): string {
  return join(ctx.launchAgentsDir, `${ctx.label}.plist`);
}

const target = (ctx: ServiceContext) => `gui/${ctx.uid}/${ctx.label}`;
const failure = (what: string, r: LaunchctlResult) =>
  `launchctl ${what} failed (${r.code}): ${(r.stderr || r.stdout).trim()}`;

export function serviceStatus(ctx: ServiceContext): ServiceStatus {
  const installed = existsSync(plistPath(ctx));
  const printed = ctx.launchctl(["print", target(ctx)]);
  if (printed.code !== 0) return { installed, loaded: false, pid: null, lastExit: null };
  // Only the job's own top-level fields, one tab deep; nested blocks repeat names like `state`.
  const field = (name: string) => new RegExp(`^\\t${name} = (.+)$`, "m").exec(printed.stdout)?.[1]?.trim();
  const pid = field("pid");
  const code = field("last exit code");
  const signal = field("last terminating signal");
  const lastExit =
    signal !== undefined ? `signal ${signal}` : code !== undefined && /^-?\d+$/.test(code) ? `exit code ${code}` : null;
  return { installed, loaded: true, pid: pid !== undefined && /^\d+$/.test(pid) ? Number(pid) : null, lastExit };
}

function isDisabled(ctx: ServiceContext): boolean {
  const listed = ctx.launchctl(["print-disabled", `gui/${ctx.uid}`]).stdout;
  const escaped = ctx.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`"${escaped}" => (disabled|true)`).test(listed);
}

function load(ctx: ServiceContext, file: string): string | null {
  if (isDisabled(ctx)) {
    const enabled = ctx.launchctl(["enable", target(ctx)]);
    if (enabled.code !== 0) return failure("enable", enabled);
  }
  const booted = ctx.launchctl(["bootstrap", `gui/${ctx.uid}`, file]);
  return booted.code === 0 ? null : failure("bootstrap", booted);
}

/**
 * Writes the plist and loads it. With the same plist already loaded it does nothing, except start
 * the app if it is stopped.
 */
export function installService(ctx: ServiceContext, plist: string): InstallOutcome {
  const file = plistPath(ctx);
  const status = serviceStatus(ctx);
  if (status.loaded && status.installed && readFileSync(file, "utf8") === plist) {
    if (status.pid !== null) return { kind: "unchanged", plist: file };
    const kicked = ctx.launchctl(["kickstart", target(ctx)]);
    return kicked.code === 0 ? { kind: "started", plist: file } : { kind: "failed", error: failure("kickstart", kicked) };
  }
  if (status.loaded) {
    const out = ctx.launchctl(["bootout", target(ctx)]);
    if (out.code !== 0) return { kind: "failed", error: failure("bootout", out) };
  }
  mkdirSync(ctx.launchAgentsDir, { recursive: true });
  writeFileSync(file, plist, { mode: 0o644 });
  chmodSync(file, 0o644);
  const error = load(ctx, file);
  return error === null ? { kind: "installed", plist: file } : { kind: "failed", error };
}

/** Unloads the job (which stops the app) and removes the plist. Safe to repeat. */
export function uninstallService(ctx: ServiceContext): UninstallOutcome {
  const status = serviceStatus(ctx);
  if (status.loaded) {
    const out = ctx.launchctl(["bootout", target(ctx)]);
    if (out.code !== 0) return { kind: "failed", error: failure("bootout", out) };
  }
  if (status.installed) rmSync(plistPath(ctx), { force: true });
  return { kind: "uninstalled", unloaded: status.loaded, removed: status.installed };
}

/** For `npm run update`: restarts the app if it is installed, reloading it when its plist changed. */
export function restartService(ctx: ServiceContext, plist: string): RestartOutcome {
  const status = serviceStatus(ctx);
  if (!status.installed) return { kind: "not_installed" };
  if (!status.loaded || readFileSync(plistPath(ctx), "utf8") !== plist) {
    const installed = installService(ctx, plist);
    return installed.kind === "failed" ? installed : { kind: "restarted" };
  }
  const kicked = ctx.launchctl(["kickstart", "-k", target(ctx)]);
  return kicked.code === 0 ? { kind: "restarted" } : { kind: "failed", error: failure("kickstart", kicked) };
}

/**
 * Stops the app without unloading it: SIGTERM makes it exit cleanly, and a clean exit is not
 * restarted. Waits until the process is gone. `npm run update` stops it before reinstalling
 * dependencies and migrating, then starts it with `restartService`.
 */
export async function stopService(
  ctx: ServiceContext,
  options: { readonly sleep?: (ms: number) => Promise<void>; readonly attempts?: number } = {},
): Promise<StopOutcome> {
  const { sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), attempts = 60 } = options;
  if (serviceStatus(ctx).pid === null) return { kind: "not_running" };
  const killed = ctx.launchctl(["kill", "SIGTERM", target(ctx)]);
  if (killed.code !== 0) return { kind: "failed", error: failure("kill", killed) };
  for (let i = 0; i < attempts; i++) {
    if (serviceStatus(ctx).pid === null) return { kind: "stopped" };
    await sleep(500);
  }
  return { kind: "failed", error: `the app did not exit within ${(attempts * 500) / 1000} s of SIGTERM` };
}
