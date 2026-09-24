import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/*.browser.test.ts", "**/browser.test.ts", "**/node_modules/**"],
    testTimeout: 15_000,
  },
});
