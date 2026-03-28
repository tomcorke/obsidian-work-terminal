import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./src/__mocks__/obsidian.ts", import.meta.url)),
    },
  },
});
