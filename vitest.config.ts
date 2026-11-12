import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // Starting a process is slower on Windows, and several tests start many.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    hookTimeout: process.platform === "win32" ? 60_000 : 10_000,
  },
});
