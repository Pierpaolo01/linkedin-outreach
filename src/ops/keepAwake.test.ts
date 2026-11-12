import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../config/settings";
import { openDb, type OpenedDb } from "../db/index";
import { campaigns, type CampaignStatus } from "../db/schema";
import { activeCampaignCount, createKeepAwake, isKeepAwakeWanted, type KeepAwakeChild } from "./keepAwake";

class FakeChild extends EventEmitter implements KeepAwakeChild {
  readonly signals: string[] = [];
  constructor(readonly pid: number) {
    super();
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  }
}

function fakeSpawn() {
  const calls: { command: string; args: readonly string[] }[] = [];
  const children: FakeChild[] = [];
  const spawn = (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    const child = new FakeChild(1000 + children.length);
    children.push(child);
    return child;
  };
  return { spawn, calls, children };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("createKeepAwake", () => {
  it("holds `caffeinate -i` tied to the app's pid while wanted, and only one", () => {
    const fake = fakeSpawn();
    const keepAwake = createKeepAwake({ spawn: fake.spawn, pid: 4321 });
    keepAwake.update({ wanted: true });
    keepAwake.update({ wanted: true });
    expect(fake.calls).toEqual([{ command: "caffeinate", args: ["-i", "-w", "4321"] }]);
    expect(keepAwake.holding()).toBe(true);
  });

  it("releases it when no longer wanted", () => {
    const fake = fakeSpawn();
    const keepAwake = createKeepAwake({ spawn: fake.spawn, pid: 4321 });
    keepAwake.update({ wanted: false });
    expect(fake.calls).toEqual([]);
    keepAwake.update({ wanted: true });
    keepAwake.update({ wanted: false });
    expect(fake.children[0]?.signals).toEqual(["SIGTERM"]);
    expect(keepAwake.holding()).toBe(false);
  });

  it("takes it again at the next update after caffeinate exits by itself", async () => {
    const fake = fakeSpawn();
    const keepAwake = createKeepAwake({ spawn: fake.spawn, pid: 4321 });
    keepAwake.update({ wanted: true });
    fake.children[0]?.emit("exit", 1, null);
    await tick();
    expect(keepAwake.holding()).toBe(false);
    keepAwake.update({ wanted: true });
    expect(fake.calls).toHaveLength(2);
  });

  it("does not throw when caffeinate cannot start, and reports it once", async () => {
    const fake = fakeSpawn();
    const errors: string[] = [];
    const keepAwake = createKeepAwake({ spawn: fake.spawn, pid: 4321, onError: (e) => errors.push(e) });
    keepAwake.update({ wanted: true });
    fake.children[0]?.emit("error", new Error("spawn caffeinate ENOENT"));
    await tick();
    keepAwake.update({ wanted: true });
    fake.children[1]?.emit("error", new Error("spawn caffeinate ENOENT"));
    await tick();
    expect(errors).toEqual(["spawn caffeinate ENOENT"]);
    expect(keepAwake.holding()).toBe(false);
  });

  it("releases on stop and stays released", () => {
    const fake = fakeSpawn();
    const keepAwake = createKeepAwake({ spawn: fake.spawn, pid: 4321 });
    keepAwake.update({ wanted: true });
    keepAwake.stop();
    keepAwake.update({ wanted: true });
    expect(fake.children[0]?.signals).toEqual(["SIGTERM"]);
    expect(fake.calls).toHaveLength(1);
  });
});

describe("caffeinate -w (real process)", () => {
  function caffeinatePids(appPid: number): number[] {
    try {
      return execFileSync("pgrep", ["-f", `caffeinate -i -w ${appPid}$`], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map(Number);
    } catch {
      return [];
    }
  }

  async function waitFor(check: () => boolean, ms = 3000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return check();
  }

  it("leaves no caffeinate behind when the app dies without calling stop", async () => {
    const app = nodeSpawn("sleep", ["30"], { stdio: "ignore" });
    const appPid = app.pid ?? 0;
    const keepAwake = createKeepAwake({ spawn: nodeSpawn, pid: appPid });
    keepAwake.update({ wanted: true });
    expect(await waitFor(() => caffeinatePids(appPid).length === 1)).toBe(true);

    app.kill("SIGKILL");
    expect(await waitFor(() => caffeinatePids(appPid).length === 0)).toBe(true);
  });
});

describe("isKeepAwakeWanted", () => {
  // Thursday 12 Nov 2026; 10:00 and 20:00 in Rome.
  const inside = new Date("2026-11-12T09:00:00Z");
  const outside = new Date("2026-11-12T19:00:00Z");
  const settings: Settings = DEFAULT_SETTINGS;

  it.each([
    ["a campaign is active inside the working window", settings, 1, inside, true],
    ["outside the working window", settings, 1, outside, false],
    ["no campaign is active", settings, 0, inside, false],
    ["the setting is off", { ...settings, keepAwake: false }, 2, inside, false],
  ])("%s", (_label, s, activeCampaigns, now, expected) => {
    expect(isKeepAwakeWanted({ settings: s, activeCampaigns, now })).toBe(expected);
  });
});

describe("activeCampaignCount", () => {
  let dir: string;
  let opened: OpenedDb;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lo-keepawake-"));
    opened = openDb(join(dir, "app.db"), { durable: false });
  });
  afterEach(() => {
    opened.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts campaigns that are running or finding", () => {
    for (const status of ["draft", "finding", "running", "running", "paused", "awaiting_approval", "completed"] as const) {
      opened.db.insert(campaigns).values(campaignRow(status)).run();
    }
    expect(activeCampaignCount(opened.db)).toBe(3);
  });
});

function campaignRow(status: CampaignStatus): typeof campaigns.$inferInsert {
  const at = new Date("2026-11-01T09:00:00Z");
  return { name: `campaign ${status}`, status, discoverySource: "search", createdAt: at, updatedAt: at };
}
