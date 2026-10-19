import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IpcMainEvent, WebContents } from "electron";
import { afterEach, expect, it } from "vitest";
import {
  createLibraryStartupLog,
  trustedLibraryState,
} from "./library-startup-log";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function options() {
  const userData = await mkdtemp(join(tmpdir(), "reader-library-log-"));
  directories.push(userData);
  return {
    userData,
    appDirectory: "C:/Reader",
    version: "0.5.4",
    isPackaged: false,
    dataDir: join(userData, "library"),
  };
}
function sender(url = "http://127.0.0.1:1234/") {
  const frame = { url };
  const contents = { mainFrame: frame } as WebContents;
  return {
    contents,
    event: { sender: contents, senderFrame: frame } as IpcMainEvent,
  };
}
const state = { total: 114, papers: 114, books: 0, failed: false };

it("records only validated counts from the trusted main frame", () => {
  const { contents, event } = sender();
  expect(
    trustedLibraryState(
      event,
      { ...state, title: "private", error: "secret" },
      contents,
      "http://127.0.0.1:1234",
    ),
  ).toEqual(state);
});

it.each([
  null,
  [],
  { ...state, total: -1 },
  { ...state, total: Infinity },
  { ...state, total: 10_000_001 },
  { ...state, papers: NaN },
  { ...state, books: 0.5 },
  { ...state, papers: "114" },
  { ...state, papers: 115 },
  { ...state, books: 1 },
  { ...state, failed: "false" },
])("ignores invalid count payload %#", (value) => {
  const { contents, event } = sender();
  expect(
    trustedLibraryState(event, value, contents, "http://127.0.0.1:1234"),
  ).toBeNull();
});

it.each([
  "other-window",
  "child-frame",
  "missing-frame",
  "external-origin",
  "invalid-url",
])("ignores %s", (scenario) => {
  const { contents, event } = sender(
    scenario === "external-origin"
      ? "https://example.com"
      : scenario === "invalid-url"
        ? "invalid"
        : undefined,
  );
  const request = {
    ...event,
    sender: scenario === "other-window" ? ({} as WebContents) : event.sender,
    senderFrame:
      scenario === "child-frame"
        ? ({ url: "http://127.0.0.1:1234/" } as NonNullable<
            IpcMainEvent["senderFrame"]
          >)
        : scenario === "missing-frame"
          ? null
          : event.senderFrame,
  };
  expect(
    trustedLibraryState(request, state, contents, "http://127.0.0.1:1234"),
  ).toBeNull();
});

it("preserves the previous launch and filters and deduplicates state records", async () => {
  const config = await options();
  const first = createLibraryStartupLog(config);
  await first.recordState(state);
  await first.recordState({
    ...state,
    title: "private",
    error: "secret",
  } as typeof state);
  const second = createLibraryStartupLog(config);
  await second.recordState({ ...state, failed: true });
  const records = (
    await readFile(
      join(config.userData, "logs", "library-startup.jsonl"),
      "utf8",
    )
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.map((record) => record.event)).toEqual([
    "startup",
    "library",
    "startup",
    "library",
  ]);
  expect(records[0]).toMatchObject({
    appDirectory: config.appDirectory,
    version: config.version,
    isPackaged: false,
    dataDir: config.dataDir,
  });
  expect(records[1]).toEqual({
    time: expect.any(String),
    event: "library",
    ...state,
  });
  expect(records[3]).toMatchObject({ failed: true });
  expect(JSON.stringify(records)).not.toMatch(/private|secret/);
});

it("bounds retained records across launches and serializes concurrent updates", async () => {
  const config = await options();
  await mkdir(join(config.userData, "logs"));
  const path = join(config.userData, "logs", "library-startup.jsonl");
  await writeFile(
    path,
    Array.from({ length: 100 }, (_, index) =>
      JSON.stringify({ event: "old", index }),
    ).join("\n") + "\n",
  );
  const log = createLibraryStartupLog(config);
  await log.ready;
  expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(64);
  await Promise.all(
    Array.from({ length: 100 }, (_, total) =>
      log.recordState({ total, papers: total, books: 0, failed: false }),
    ),
  );
  const records = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records).toHaveLength(64);
  expect(records[0].total).toBe(36);
  expect(records[63].total).toBe(99);
});

it("does not reject when the log directory cannot be created", async () => {
  const config = await options();
  await writeFile(join(config.userData, "logs"), "occupied");
  const log = createLibraryStartupLog(config);
  await expect(log.ready).resolves.toBeUndefined();
  await expect(log.recordState(state)).resolves.toBeUndefined();
});
