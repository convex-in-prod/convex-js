import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Cache scripts use the Node test runner through npm run test:build-cache.
    exclude: [
      ...configDefaults.exclude,
      "scripts/run-tsrs.test.mjs",
      "scripts/tsrs-cache.test.mjs",
    ],
    alias: {
      "@jest/globals": "vitest",
    },
    isolate: true,
    watch: false,
    //environment: "node", // "node" is the default
    server: {
      deps: {
        inline: ["@xterm/headless", "@inquirer/testing"],
      },
    },
  },
});
