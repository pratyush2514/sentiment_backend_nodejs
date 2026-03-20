import { preview } from "@vitest/browser-preview";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["vitest-example/**/*.test.ts"],
    setupFiles: ["./vitest.browser.setup.ts"],
    browser: {
      enabled: true,
      provider: preview(),
      instances: [
        {
          name: "chromium",
          browser: "chromium",
        },
      ],
    },
  },
});
