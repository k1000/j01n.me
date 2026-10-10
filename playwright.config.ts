import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "apps/web/e2e",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4179", browserName: "chromium", trace: "retain-on-failure" },
  webServer: {
    command: "node --import tsx scripts/room-ui-fixture.ts",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
  },
});
