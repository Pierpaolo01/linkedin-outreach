import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { servicePlist } from "./service";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lo-service-macos-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("generates a property list accepted by macOS", () => {
  const file = join(dir, "check.plist");
  writeFileSync(file, servicePlist({
    label: "com.linkedin-outreach.test",
    nodePath: process.execPath,
    repoDir: dir,
    logsDir: join(dir, "logs"),
    env: { NO_OPEN: "1" },
  }));
  expect(execFileSync("plutil", ["-lint", file], { encoding: "utf8" })).toContain("OK");
});
