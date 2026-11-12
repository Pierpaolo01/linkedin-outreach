/** The fake-driver apps the browser tests start (see playwright.config.ts). None touches LinkedIn. */
export const APPS = {
  /** Seeded with the demo data (scripts/seed-demo.ts); the session is fine. */
  demo: { port: 4748, states: "ok", delayMs: 0, seed: "demo" },
  /** Seeded with the demo data and an active safety stop. */
  stop: { port: 4749, states: "ok", delayMs: 0, seed: "safety-stop" },
  /** Empty; the session starts logged out and the first Re-check finds it connected. The delay is how long Re-check stays busy. */
  recheck: { port: 4750, states: "logged_out,ok", delayMs: 2500, seed: "none" },
  /** Empty; the session check finds a checkpoint. */
  checkpoint: { port: 4751, states: "checkpoint", delayMs: 0, seed: "none" },
} as const satisfies Record<string, { port: number; states: string; delayMs: number; seed: "demo" | "safety-stop" | "none" }>;

export type AppKey = keyof typeof APPS;

export const appUrl = (key: AppKey, path = "/") => `http://127.0.0.1:${APPS[key].port}${path}`;
