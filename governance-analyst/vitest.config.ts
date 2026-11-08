import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // STANDARD.md rule 6: fixtures recorded, never the network. test/setup.ts
    // replaces fetch with a thrower unless LIVE_TESTS=1 is set on purpose.
    setupFiles: ["test/setup.ts"],
  },
});
