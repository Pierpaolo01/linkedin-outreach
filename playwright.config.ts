import { defineConfig } from "@playwright/test";

// Dashboard browser tests. They run the app on the fake driver and never touch LinkedIn.
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { channel: "chrome", baseURL: "http://127.0.0.1:4748" },
});
