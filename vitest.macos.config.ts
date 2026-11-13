import { defineConfig } from "vitest/config";

if (process.platform !== "darwin") {
  throw new Error("Native macOS checks require a Mac. Run npm test for the portable suite.");
}

export default defineConfig({
  test: {
    include: ["src/**/*.macos.test.ts"],
    environment: "node",
  },
});
