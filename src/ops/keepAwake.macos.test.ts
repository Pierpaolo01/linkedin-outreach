import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createKeepAwake } from "./keepAwake";

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
    try {
      keepAwake.update({ wanted: true });
      expect(await waitFor(() => caffeinatePids(appPid).length === 1)).toBe(true);

      app.kill("SIGKILL");
      expect(await waitFor(() => caffeinatePids(appPid).length === 0)).toBe(true);
    } finally {
      keepAwake.stop();
      app.kill("SIGKILL");
    }
  });
});
