import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { dataPaths } from "../config/paths";
import { defaultDataDir, parseEnv, scratchDataDirProblem } from "./env";

describe("parseEnv", () => {
  it("runs the engine and the live driver by default", () => {
    const parsed = parseEnv({});
    expect(parsed.success && parsed.data).toMatchObject({ ENGINE: "on", LINKEDIN_DRIVER: "live", PORT: 4747 });
  });

  it("ENGINE=off leaves the engine out", () => {
    const parsed = parseEnv({ ENGINE: "off" });
    expect(parsed.success && parsed.data.ENGINE).toBe("off");
  });

  it("rejects an ENGINE value it does not know, rather than guessing", () => {
    expect(parseEnv({ ENGINE: "false" }).success).toBe(false);
  });

  it("has no switch that turns sends on", () => {
    const parsed = parseEnv({ OUTREACH: "on", LINKEDIN_SENDS: "1" });
    expect(parsed.success && Object.keys(parsed.data).sort()).toEqual(
      ["ENGINE", "FAKE_SESSION_DELAY_MS", "LINKEDIN_DRIVER", "PORT"].sort(),
    );
  });
});

describe("scratchDataDirProblem: pretend data never goes into the real data directory", () => {
  it("names the same default data directory as dataPaths()", () => {
    const saved = process.env["LINKEDIN_OUTREACH_DATA_DIR"];
    delete process.env["LINKEDIN_OUTREACH_DATA_DIR"];
    try {
      expect(defaultDataDir()).toBe(dataPaths().root);
    } finally {
      if (saved !== undefined) process.env["LINKEDIN_OUTREACH_DATA_DIR"] = saved;
    }
  });

  it("refuses when LINKEDIN_OUTREACH_DATA_DIR is not set or empty", () => {
    expect(scratchDataDirProblem({})).toMatch(/LINKEDIN_OUTREACH_DATA_DIR is not set/);
    expect(scratchDataDirProblem({ LINKEDIN_OUTREACH_DATA_DIR: " " })).toMatch(/LINKEDIN_OUTREACH_DATA_DIR is not set/);
  });

  it("refuses the default data directory, however it is written", () => {
    const real = defaultDataDir();
    for (const written of [real, `${real}/`, `${real}/../linkedin-outreach`, real.toUpperCase()]) {
      expect(scratchDataDirProblem({ LINKEDIN_OUTREACH_DATA_DIR: written })).toMatch(/is the real data directory/);
    }
  });

  it("accepts any other folder", () => {
    expect(scratchDataDirProblem({ LINKEDIN_OUTREACH_DATA_DIR: join(tmpdir(), "lo-demo") })).toBeNull();
  });
});

describe("the demo seed (scripts/seed-demo.ts)", () => {
  const ROOT = fileURLToPath(new URL("../..", import.meta.url));
  const TSX = join(ROOT, "node_modules", ".bin", "tsx");

  function seed(dataDir: string | null) {
    const home = mkdtempSync(join(tmpdir(), "lo-home-"));
    const env: Record<string, string | undefined> = { ...process.env, HOME: home };
    delete env["LINKEDIN_OUTREACH_DATA_DIR"];
    if (dataDir !== null) env["LINKEDIN_OUTREACH_DATA_DIR"] = dataDir;
    const result = spawnSync(TSX, ["scripts/seed-demo.ts"], { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 });
    return { ...result, home };
  }

  it("refuses without LINKEDIN_OUTREACH_DATA_DIR, and touches nothing", { timeout: 70_000 }, () => {
    const result = seed(null);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("LINKEDIN_OUTREACH_DATA_DIR");
    expect(existsSync(join(result.home, "Library"))).toBe(false);
    rmSync(result.home, { recursive: true, force: true });
  });

  it("refuses the default data directory even when it is empty", { timeout: 70_000 }, () => {
    const home = mkdtempSync(join(tmpdir(), "lo-home-"));
    const real = join(home, "Library", "Application Support", "linkedin-outreach");
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, LINKEDIN_OUTREACH_DATA_DIR: real };
    const result = spawnSync(TSX, ["scripts/seed-demo.ts"], { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is the real data directory");
    expect(existsSync(join(home, "Library"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("seeds a scratch folder", { timeout: 70_000 }, () => {
    const scratch = mkdtempSync(join(tmpdir(), "lo-demo-"));
    const result = seed(scratch);
    expect(result.status).toBe(0);
    expect(existsSync(join(scratch, "app.db"))).toBe(true);
    rmSync(scratch, { recursive: true, force: true });
    rmSync(result.home, { recursive: true, force: true });
  });
});
