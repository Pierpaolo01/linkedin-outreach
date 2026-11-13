import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/*.macos.test.ts"],
    maxWorkers: 2,
    environment: "node",
  },
});
