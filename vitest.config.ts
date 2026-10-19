import { defineConfig } from "vitest/config";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
// Linked node_modules can resolve outside a worktree. Allow that dependency
// directory without disabling Vite's filesystem boundary for the test server.
const dependencies = realpathSync(new URL("./node_modules", import.meta.url));

export default defineConfig({
  server: { fs: { allow: [root, dependencies] } },
  test: {
    // Each UI worker loads a large jsdom/component graph. Bound memory usage
    // on developer machines instead of stretching individual test deadlines.
    maxWorkers: 2,
    // The default 5s is too tight for the full suite on CI runners.
    testTimeout: 10_000,
    server: {
      deps: {
        // Lobe Avatar imports UI modules that load Emoji Mart JSON through Vite.
        inline: [/@lobehub\/ui/, /@emoji-mart\/data/],
      },
    },
  },
});
