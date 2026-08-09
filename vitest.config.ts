import { defineConfig } from "vitest/config";

const serializeWindowsCi =
  process.platform === "win32" && process.env["CI"] === "true";

export default defineConfig({
  test: {
    // The hosted Windows runner throttles child-process and PowerShell cold
    // starts when all integration files run together. Preserve behavioral
    // deadlines by serializing files instead of weakening their timeouts.
    fileParallelism: !serializeWindowsCi,
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    maxWorkers: serializeWindowsCi ? 1 : undefined,
  },
});
