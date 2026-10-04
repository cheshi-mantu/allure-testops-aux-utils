import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts", "web/src/**/*.test.ts"],
    // Reads failed on purpose by the mock are repeated with a growing pause.
    testTimeout: 60_000,
  },
});
