import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { APPS, type AppKey } from "./e2e/apps";

// Dashboard browser tests. They run the app on the fake driver and never touch LinkedIn.
// Each app gets its own empty data directory, so the real one is never read or written; the
// seeded ones are filled with invented people by scripts/seed-demo.ts before the app starts.
// The engine is off (ENGINE=off) so the seeded numbers do not move during a test.

function fakeApp(key: AppKey) {
  const { port, states, delayMs, seed } = APPS[key];
  const seedCommand = seed === "none" ? "" : `npx tsx scripts/seed-demo.ts${seed === "safety-stop" ? " --safety-stop" : ""} && `;
  return {
    command: `${seedCommand}npm start`,
    url: `http://127.0.0.1:${port}/api/health`,
    // Never reuse a server already on the port: it could be the real app.
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "pipe" as const,
    gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5_000 },
    env: {
      LINKEDIN_DRIVER: "fake",
      ENGINE: "off",
      NO_OPEN: "1",
      PORT: String(port),
      FAKE_SESSION_STATES: states,
      FAKE_SESSION_DELAY_MS: String(delayMs),
      LINKEDIN_OUTREACH_DATA_DIR: mkdtempSync(join(tmpdir(), "lo-e2e-")),
    },
  };
}

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { channel: "chrome", baseURL: `http://127.0.0.1:${APPS.demo.port}` },
  webServer: [fakeApp("demo"), fakeApp("stop"), fakeApp("recheck"), fakeApp("checkpoint")],
});
