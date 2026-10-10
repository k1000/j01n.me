import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/web/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/._*"],
  },
});
