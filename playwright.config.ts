import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

// Dashboard browser tests. They run the app on the fake driver and never touch LinkedIn.
// Each app gets its own empty data directory, so the real one is never read or written.

function fakeApp({ port, states, delayMs }: { port: number; states: string; delayMs: number }) {
  return {
    command: "npm start",
    url: `http://127.0.0.1:${port}/api/health`,
    // Never reuse a server already on the port: it could be the real app.
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "pipe" as const,
    gracefulShutdown: { signal: "SIGTERM" as const, timeout: 5_000 },
    env: {
      LINKEDIN_DRIVER: "fake",
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
  use: { channel: "chrome", baseURL: "http://127.0.0.1:4748" },
  webServer: [
    fakeApp({ port: 4748, states: "logged_out,ok", delayMs: 500 }),
    fakeApp({ port: 4750, states: "checkpoint", delayMs: 0 }),
  ],
});
