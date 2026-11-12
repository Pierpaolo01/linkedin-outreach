import { inArray, sql } from "drizzle-orm";
import type { Settings } from "../config/settings";
import type { Db } from "../db/index";
import { campaigns, type CampaignStatus } from "../db/schema";
import { isInWorkingWindow } from "../engine/workingWindow";

/**
 * Keep-awake (spec section 11): while wanted, the app holds `caffeinate -i`
 * as a child process so the Mac does not idle-sleep in the middle of a working
 * day. `-w <app pid>` makes caffeinate exit by itself when the app dies, even
 * on a crash or SIGKILL, so it is never left behind.
 */

/** The part of a child process this module uses; Node's ChildProcess satisfies it. */
export interface KeepAwakeChild {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit" | "error", listener: (arg?: unknown) => void): unknown;
}

export type KeepAwakeSpawn = (command: string, args: readonly string[], options: { stdio: "ignore" }) => KeepAwakeChild;

export interface KeepAwakeOptions {
  /** `spawn` from node:child_process, or a fake in tests. */
  readonly spawn: KeepAwakeSpawn;
  /** The app's pid; caffeinate exits when it does. */
  readonly pid?: number;
  /** Called once per failure streak when caffeinate cannot start. */
  readonly onError?: (message: string) => void;
}

export interface KeepAwake {
  /** Takes or releases the assertion to match `wanted`. Call it each minute. */
  update(state: { readonly wanted: boolean }): void;
  /** Releases the assertion for good; later updates do nothing. Call it on shutdown. */
  stop(): void;
  holding(): boolean;
}

export function createKeepAwake(options: KeepAwakeOptions): KeepAwake {
  const { spawn, pid = process.pid, onError = () => undefined } = options;
  let child: KeepAwakeChild | null = null;
  let stopped = false;
  let failing = false;

  function release(): void {
    const current = child;
    child = null;
    current?.kill("SIGTERM");
  }

  function take(): void {
    const current = spawn("caffeinate", ["-i", "-w", String(pid)], { stdio: "ignore" });
    child = current;
    current.once("exit", () => {
      if (child === current) child = null;
    });
    current.once("error", (error) => {
      if (child === current) child = null;
      if (!failing) onError(error instanceof Error ? error.message : String(error));
      failing = true;
    });
  }

  return {
    update({ wanted }) {
      if (stopped) return;
      if (wanted && child === null) take();
      if (!wanted) {
        release();
        failing = false;
      }
    },
    stop() {
      stopped = true;
      release();
    },
    holding: () => child !== null,
  };
}

export const ACTIVE_STATUSES = ["running", "finding"] as const satisfies readonly CampaignStatus[];

/** Campaigns whose work needs the Mac awake: running or finding. */
export function activeCampaignCount(db: Db): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(campaigns)
    .where(inArray(campaigns.status, [...ACTIVE_STATUSES]))
    .get();
  return row?.n ?? 0;
}

/** The app's per-minute decision: the setting is on, a campaign is active, and it is working time. */
export function isKeepAwakeWanted(input: {
  readonly settings: Settings;
  readonly activeCampaigns: number;
  readonly now: Date;
}): boolean {
  return input.settings.keepAwake && input.activeCampaigns > 0 && isInWorkingWindow(input.settings, input.now);
}
