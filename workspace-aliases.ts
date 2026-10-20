import { fileURLToPath } from "node:url";

// A worktree may share node_modules with another checkout. Resolve Reader's
// source packages from this checkout so builds and tests use the same code.
export const readerWorkspaceAliases = {
  "@reader/api": fileURLToPath(
    new URL("./packages/api-client/src/index.ts", import.meta.url),
  ),
  "@reader/core": fileURLToPath(
    new URL("./packages/reader-core/src/index.ts", import.meta.url),
  ),
  "@reader/ui": fileURLToPath(new URL("./packages/ui/src", import.meta.url)),
};
