import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appServiceSpec,
  installService,
  privacyProtectedFolder,
  restartService,
  servicePlist,
  serviceStatus,
  stopService,
  uninstallService,
  type Launchctl,
  type ServiceContext,
} from "./service";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lo-service-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LABEL = "com.linkedin-outreach.app";

/** A launchd stand-in: tracks which labels are loaded and whether their process runs. */
function fakeLaunchd(options: { disabled?: boolean } = {}) {
  const loaded = new Map<string, { plist: string; pid: number | null; lastExit: number | null }>();
  const calls: string[] = [];
  let disabled = options.disabled ?? false;
  let nextPid = 500;
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const launchctl: Launchctl = (args) => {
    calls.push(args.join(" "));
    const [verb, target = "", path = ""] = args;
    const label = target.split("/")[2] ?? "";
    switch (verb) {
      case "print": {
        const job = loaded.get(label);
        if (!job) return { code: 113, stdout: "", stderr: `Could not find service "${label}"` };
        return ok(
          [
            `gui/501/${label} = {`,
            `\tpath = ${job.plist}`,
            `\tstate = ${job.pid === null ? "not running" : "running"}`,
            ...(job.pid === null ? [] : [`\tpid = ${job.pid}`]),
            `\tlast exit code = ${job.lastExit === null ? "(never exited)" : job.lastExit}`,
            "\tendpoints = {",
            "\t\tstate = active",
            "\t}",
            "}",
          ].join("\n"),
        );
      }
      case "print-disabled":
        return ok(`disabled services = {\n\t"${LABEL}" => ${disabled ? "disabled" : "enabled"}\n}`);
      case "enable":
        disabled = false;
        return ok();
      case "bootstrap": {
        if (disabled) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
        const plist = readFileSync(path, "utf8");
        const name = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? "";
        if (loaded.has(name)) return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
        loaded.set(name, { plist: path, pid: nextPid++, lastExit: null });
        return ok();
      }
      case "bootout":
        if (!loaded.delete(label)) return { code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" };
        return ok();
      case "kill": {
        const job = loaded.get(path.split("/")[2] ?? "");
        if (!job) return { code: 113, stdout: "", stderr: "Could not find service" };
        job.pid = null;
        job.lastExit = 0;
        return ok();
      }
      case "kickstart": {
        const job = loaded.get((target === "-k" ? path : target).split("/")[2] ?? "");
        if (!job) return { code: 113, stdout: "", stderr: "Could not find service" };
        job.pid = nextPid++;
        return ok();
      }
      default:
        return { code: 64, stdout: "", stderr: `unexpected ${args.join(" ")}` };
    }
  };
  return { launchctl, loaded, calls };
}

function context(launchctl: Launchctl): ServiceContext {
  return { label: LABEL, launchAgentsDir: join(dir, "LaunchAgents"), uid: 501, launchctl };
}

const spec = {
  label: LABEL,
  nodePath: "/Users/someone/.nvm/versions/node/v22.23.2/bin/node",
  repoDir: "/Users/someone/linkedin-outreach",
  logsDir: "/Users/someone/Library/Application Support/linkedin-outreach/logs",
  env: { NO_OPEN: "1", PATH: "/usr/bin:/bin" },
};

describe("servicePlist", () => {
  const plist = servicePlist(spec);

  it("runs the app with absolute node and repo paths, in the repo", () => {
    expect(plist).toContain(`<key>Label</key>\n  <string>${LABEL}</string>`);
    expect(plist).toContain(
      [
        "<key>ProgramArguments</key>",
        "  <array>",
        `    <string>${spec.nodePath}</string>`,
        "    <string>--import</string>",
        "    <string>file:///Users/someone/linkedin-outreach/node_modules/tsx/dist/loader.mjs</string>",
        "    <string>/Users/someone/linkedin-outreach/src/main.ts</string>",
        "  </array>",
      ].join("\n"),
    );
    expect(plist).toContain(`<key>WorkingDirectory</key>\n  <string>${spec.repoDir}</string>`);
  });

  it("starts at load and restarts only after a crash, at most every 30 seconds", () => {
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>");
    expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>30</integer>");
  });

  it("logs to the data directory with private files, and passes the environment", () => {
    expect(plist).toContain(`<key>StandardOutPath</key>\n  <string>${spec.logsDir}/service.out.log</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key>\n  <string>${spec.logsDir}/service.err.log</string>`);
    expect(plist).toContain("<key>Umask</key>\n  <integer>63</integer>");
    expect(plist).toContain(
      "<key>EnvironmentVariables</key>\n  <dict>\n    <key>NO_OPEN</key>\n    <string>1</string>\n    <key>PATH</key>\n    <string>/usr/bin:/bin</string>\n  </dict>",
    );
  });

  it("escapes XML in paths", () => {
    expect(servicePlist({ ...spec, repoDir: "/Users/a&b/<repo>" })).toContain(
      "<string>/Users/a&amp;b/&lt;repo&gt;</string>",
    );
  });
});

describe("installService", () => {
  it("writes the plist into LaunchAgents and loads it", () => {
    const launchd = fakeLaunchd();
    const ctx = context(launchd.launchctl);
    const outcome = installService(ctx, servicePlist(spec));

    const file = join(dir, "LaunchAgents", `${LABEL}.plist`);
    expect(outcome).toEqual({ kind: "installed", plist: file });
    expect(readFileSync(file, "utf8")).toBe(servicePlist(spec));
    expect(statSync(file).mode & 0o777).toBe(0o644);
    expect(launchd.calls).toContain(`bootstrap gui/501 ${file}`);
    expect(launchd.loaded.has(LABEL)).toBe(true);
    expect(launchd.calls.some((c) => c.startsWith("enable"))).toBe(false);
  });

  it("does nothing the second time when the plist has not changed", () => {
    const launchd = fakeLaunchd();
    const ctx = context(launchd.launchctl);
    installService(ctx, servicePlist(spec));
    const pid = launchd.loaded.get(LABEL)?.pid;
    expect(installService(ctx, servicePlist(spec)).kind).toBe("unchanged");
    expect(launchd.loaded.get(LABEL)?.pid).toBe(pid);
  });

  it("starts a loaded service that is stopped when the plist has not changed", () => {
    const launchd = fakeLaunchd();
    const ctx = context(launchd.launchctl);
    installService(ctx, servicePlist(spec));
    const job = launchd.loaded.get(LABEL);
    if (job) job.pid = null;
    expect(installService(ctx, servicePlist(spec)).kind).toBe("started");
    expect(launchd.calls).toContain(`kickstart gui/501/${LABEL}`);
    expect(serviceStatus(ctx).pid).not.toBeNull();
  });

  it("reloads when the plist changed, for example a new Node path", () => {
    const launchd = fakeLaunchd();
    const ctx = context(launchd.launchctl);
    installService(ctx, servicePlist(spec));
    const changed = servicePlist({ ...spec, nodePath: "/opt/homebrew/bin/node" });
    expect(installService(ctx, changed).kind).toBe("installed");
    expect(launchd.calls.filter((c) => c.startsWith("bootout"))).toHaveLength(1);
    expect(readFileSync(join(dir, "LaunchAgents", `${LABEL}.plist`), "utf8")).toBe(changed);
    expect(launchd.loaded.has(LABEL)).toBe(true);
  });

  it("enables the label first when launchd has it disabled", () => {
    const launchd = fakeLaunchd({ disabled: true });
    expect(installService(context(launchd.launchctl), servicePlist(spec)).kind).toBe("installed");
    expect(launchd.calls).toContain(`enable gui/501/${LABEL}`);
  });

  it("reports a failed load", () => {
    const failing: Launchctl = (args) =>
      args[0] === "bootstrap"
        ? { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }
        : fakeLaunchd().launchctl(args);
    const outcome = installService(context(failing), servicePlist(spec));
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.error).toContain("Input/output error");
  });
});

describe("uninstallService", () => {
  it("unloads and removes the plist, and is safe to repeat", () => {
    const launchd = fakeLaunchd();
    const ctx = context(launchd.launchctl);
    installService(ctx, servicePlist(spec));

    expect(uninstallService(ctx)).toEqual({ kind: "uninstalled", unloaded: true, removed: true });
    expect(launchd.loaded.has(LABEL)).toBe(false);
    expect(existsSync(join(dir, "LaunchAgents", `${LABEL}.plist`))).toBe(false);

    expect(uninstallService(ctx)).toEqual({ kind: "uninstalled", unloaded: false, removed: false });
  });

  it("unloads a loaded job whose plist was already deleted", () => {
    const launchd = fakeLaunchd();
    const ctx = context(launchd.launchctl);
    installService(ctx, servicePlist(spec));
    rmSync(join(dir, "LaunchAgents", `${LABEL}.plist`));
    expect(uninstallService(ctx)).toEqual({ kind: "uninstalled", unloaded: true, removed: false });
  });
});

describe("serviceStatus", () => {
  it("is not installed on a fresh Mac", () => {
    expect(serviceStatus(context(fakeLaunchd().launchctl))).toEqual({
      installed: false,
      loaded: false,
      pid: null,
      lastExit: null,
    });
  });

  it("reads the pid and last exit from launchctl print", () => {
    const launchd = fakeLaunchd();
    const ctx = context(launchd.launchctl);
    installService(ctx, servicePlist(spec));
    const job = launchd.loaded.get(LABEL);
    if (job) job.lastExit = 1;
    expect(serviceStatus(ctx)).toEqual({ installed: true, loaded: true, pid: 500, lastExit: "exit code 1" });
  });

  it("reads a stopped job and a job killed by a signal", () => {
    const killed: Launchctl = () => ({
      code: 0,
      stdout: "x = {\n\tstate = not running\n\tlast exit code = (never exited)\n\tlast terminating signal = Killed: 9\n}",
      stderr: "",
    });
    expect(serviceStatus(context(killed))).toEqual({
      installed: false,
      loaded: true,
      pid: null,
      lastExit: "signal Killed: 9",
    });
  });
});

describe("restartService", () => {
  it("restarts a loaded service in place", () => {
    const launchd = fakeLaunchd();
    const ctx = context(launchd.launchctl);
    installService(ctx, servicePlist(spec));
    expect(restartService(ctx, servicePlist(spec)).kind).toBe("restarted");
    expect(launchd.calls).toContain(`kickstart -k gui/501/${LABEL}`);
    expect(launchd.loaded.get(LABEL)?.pid).toBe(501);
  });

  it("does nothing when the service is not installed", () => {
    const launchd = fakeLaunchd();
    expect(restartService(context(launchd.launchctl), servicePlist(spec)).kind).toBe("not_installed");
    expect(launchd.loaded.size).toBe(0);
  });

  it("rewrites and reloads when the plist changed", () => {
    const launchd = fakeLaunchd();
    const ctx = context(launchd.launchctl);
    installService(ctx, servicePlist(spec));
    const changed = servicePlist({ ...spec, nodePath: "/opt/homebrew/bin/node" });
    expect(restartService(ctx, changed).kind).toBe("restarted");
    expect(readFileSync(join(dir, "LaunchAgents", `${LABEL}.plist`), "utf8")).toBe(changed);
  });
});

describe("appServiceSpec", () => {
  it("passes NO_OPEN, a PATH led by node's folder without npm's .bin folders, and a custom data directory", () => {
    const built = appServiceSpec({
      label: LABEL,
      repoDir: "/r",
      nodePath: "/n/bin/node",
      logsDir: "/d/logs",
      processEnv: {
        PATH: "/r/node_modules/.bin:/node_modules/.bin:/opt/homebrew/bin:/n/bin:/usr/bin",
        LINKEDIN_OUTREACH_DATA_DIR: "/d",
        SECRET_TOKEN: "x",
      },
    });
    expect(built.env).toEqual({ NO_OPEN: "1", PATH: "/n/bin:/opt/homebrew/bin:/usr/bin", LINKEDIN_OUTREACH_DATA_DIR: "/d" });
  });

  it("falls back to the system PATH and leaves the data directory to the default", () => {
    const built = appServiceSpec({ label: LABEL, repoDir: "/r", nodePath: "/n/bin/node", logsDir: "/d/logs", processEnv: {} });
    expect(built.env).toEqual({ NO_OPEN: "1", PATH: "/n/bin:/usr/bin:/bin:/usr/sbin:/sbin" });
  });

  it("adds extra variables last", () => {
    const built = appServiceSpec({
      label: LABEL,
      repoDir: "/r",
      nodePath: "/n/bin/node",
      logsDir: "/d/logs",
      processEnv: {},
      extraEnv: { PORT: "4790" },
    });
    expect(Object.keys(built.env)).toEqual(["NO_OPEN", "PATH", "PORT"]);
  });
});

describe("stopService", () => {
  it("sends SIGTERM to a running service and waits until it has exited; launchd keeps it stopped", async () => {
    const launchd = fakeLaunchd();
    const ctx = context(launchd.launchctl);
    installService(ctx, servicePlist(spec));
    expect(await stopService(ctx, { sleep: async () => undefined })).toEqual({ kind: "stopped" });
    expect(launchd.calls).toContain(`kill SIGTERM gui/501/${LABEL}`);
    expect(serviceStatus(ctx)).toMatchObject({ loaded: true, pid: null });
  });

  it("does nothing when it is not running", async () => {
    const launchd = fakeLaunchd();
    expect(await stopService(context(launchd.launchctl), { sleep: async () => undefined })).toEqual({ kind: "not_running" });
    expect(launchd.calls.some((c) => c.startsWith("kill"))).toBe(false);
  });

  it("fails when the process does not exit in time", async () => {
    const launchd = fakeLaunchd();
    const ctx = context(launchd.launchctl);
    installService(ctx, servicePlist(spec));
    const stubborn: Launchctl = (args) => (args[0] === "kill" ? { code: 0, stdout: "", stderr: "" } : launchd.launchctl(args));
    const outcome = await stopService({ ...ctx, launchctl: stubborn }, { sleep: async () => undefined, attempts: 3 });
    expect(outcome.kind).toBe("failed");
  });
});

describe("privacyProtectedFolder", () => {
  it.each([
    ["/Users/a/Documents/linkedin-outreach", "~/Documents"],
    ["/Users/a/Desktop/x/linkedin-outreach", "~/Desktop"],
    ["/Users/a/Downloads/linkedin-outreach", "~/Downloads"],
    ["/Users/a/Library/Mobile Documents/com~apple~CloudDocs/lo", "iCloud Drive"],
    ["/Users/a/linkedin-outreach", null],
    ["/Users/a/Documents-old/linkedin-outreach", null],
    ["/Users/a/Developer/linkedin-outreach", null],
  ])("%s -> %s", (repoDir, expected) => {
    expect(privacyProtectedFolder(repoDir, "/Users/a")).toBe(expected);
  });
});
