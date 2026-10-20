import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build, normalizePath } from "vite";

it("builds Reader packages from this checkout even when dependencies contain an older checkout", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "reader-workspace-build-"));
  try {
    const stalePackages = [
      {
        name: "api",
        source: "export const api = {}; export function configureAPI() {}",
      },
      {
        name: "core",
        source: "export const defaultTheme = { autoAnalyzeMethods: 'stale' };",
      },
      {
        name: "ui",
        source: "export const cn = () => 'stale';",
      },
    ];
    for (const { name, source } of stalePackages) {
      const directory = join(fixture, "node_modules", "@reader", name);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          name: `@reader/${name}`,
          type: "module",
          exports:
            name === "ui" ? { "./lib/utils": "./index.js" } : "./index.js",
        }),
      );
      await writeFile(join(directory, "index.js"), source);
    }
    const entry = join(fixture, "entry.ts");
    await writeFile(
      entry,
      `
        import { api, configureAPI } from "@reader/api";
        import { defaultTheme } from "@reader/core";
        import { cn } from "@reader/ui/lib/utils";
        export { api, configureAPI, defaultTheme };
        export const classes = cn("px-2", false, "px-4");
      `,
    );
    const configFile = fileURLToPath(
      new URL("./vite.config.ts", import.meta.url),
    );
    const result = await build({
      configFile,
      root: fixture,
      logLevel: "silent",
      build: {
        write: false,
        minify: true,
        lib: { entry, formats: ["cjs"], fileName: "workspace-regression" },
        rollupOptions: { output: { exports: "named" } },
      },
    });
    const output = Array.isArray(result) ? result[0] : result;
    if (!("output" in output))
      throw new Error("Expected a completed Vite build");
    const chunk = output.output.find(
      (item) => item.type === "chunk" && item.isEntry,
    );
    if (!chunk || chunk.type !== "chunk")
      throw new Error("Expected a built entry chunk");

    const builtModules = Object.keys(chunk.modules);
    for (const source of [
      "../../packages/api-client/src/index.ts",
      "../../packages/reader-core/src/index.ts",
      "../../packages/ui/src/lib/utils.ts",
    ]) {
      expect(builtModules).toContain(
        normalizePath(fileURLToPath(new URL(source, import.meta.url))),
      );
    }
    expect(
      builtModules.some((id) =>
        id.startsWith(normalizePath(join(fixture, "node_modules", "@reader"))),
      ),
    ).toBe(false);

    const state = {
      documentId: "paper/有空格 id",
      status: "idle",
      content: "",
      detail: "",
    };
    const fetch = vi.fn(async () => Response.json(state));
    const exports: {
      api?: {
        methodAnalysis(id: string): Promise<unknown>;
        startMethodAnalysis(id: string, force?: boolean): Promise<unknown>;
        cancelMethodAnalysis(id: string): Promise<unknown>;
      };
      configureAPI?: (token: string) => void;
      defaultTheme?: {
        autoAnalyzeMethods?: boolean;
        methodAnalysisPrompt?: string;
      };
      classes?: string;
    } = {};
    // Execute the production bundle without mocking the API package. Only the
    // HTTP boundary is replaced, so missing built methods fail as in Reader.
    runInNewContext(chunk.code, {
      exports,
      fetch,
      FormData,
      Headers,
      Request,
      Response,
      URL,
      URLSearchParams,
    });
    expect(exports.defaultTheme).toMatchObject({
      autoAnalyzeMethods: false,
      methodAnalysisPrompt: "",
    });
    expect(exports.classes).toBe("px-4");
    expect(exports.configureAPI).toBeTypeOf("function");
    exports.configureAPI!("build-regression-token");
    const api = exports.api!;
    await expect(api.methodAnalysis(state.documentId)).resolves.toEqual(state);
    await expect(api.startMethodAnalysis(state.documentId)).resolves.toEqual(
      state,
    );
    await expect(
      api.startMethodAnalysis(state.documentId, true),
    ).resolves.toEqual(state);
    await expect(api.cancelMethodAnalysis(state.documentId)).resolves.toEqual(
      state,
    );
    const endpoint = `/api/documents/${encodeURIComponent(state.documentId)}/method-analysis`;
    expect(fetch.mock.calls).toEqual([
      [
        endpoint,
        {
          headers: {
            Authorization: "Bearer build-regression-token",
            "Content-Type": "application/json",
          },
        },
      ],
      ...[
        { action: "start", force: false },
        { action: "start", force: true },
        { action: "cancel" },
      ].map((body) => [
        endpoint,
        {
          method: "POST",
          body: JSON.stringify(body),
          headers: {
            Authorization: "Bearer build-regression-token",
            "Content-Type": "application/json",
          },
        },
      ]),
    ]);
  } finally {
    // Only remove the uniquely allocated fixture directly under the temp dir.
    const target = resolve(fixture);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("reader-workspace-build-")
    ) {
      throw new Error("Refusing to remove an unexpected fixture path");
    }
    await rm(target, { recursive: true, force: true });
  }
}, 30_000);
