import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { dataPaths } from "../config/paths";
import { runDoctor } from "./checks";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lo-doctor-macos-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

it("reads the Chrome version from its property list with macOS tools", () => {
  const chromeApp = join(dir, "Google Chrome.app");
  mkdirSync(join(chromeApp, "Contents"), { recursive: true });
  writeFileSync(join(chromeApp, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>142.0.7444.60</string></dict></plist>`);
  const report = runDoctor({
    paths: dataPaths(join(dir, "data")),
    chromeApp,
    service: {
      label: "com.linkedin-outreach.test",
      launchAgentsDir: join(dir, "LaunchAgents"),
      uid: 501,
      launchctl: () => ({ code: 113, stdout: "", stderr: "not loaded" }),
    },
  });
  expect(report.checks.find((check) => check.name === "chrome")?.detail).toContain("142.0.7444.60");
});
