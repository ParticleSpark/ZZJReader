import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IpcMainEvent, WebContents } from "electron";

export interface LibraryState {
  total: number;
  papers: number;
  books: number;
  failed: boolean;
}

/** Accept only the app's main frame and counts, never document or error text. */
export function trustedLibraryState(
  event: IpcMainEvent,
  value: unknown,
  contents: WebContents | undefined,
  appURL: string,
): LibraryState | null {
  if (
    !contents ||
    event.sender !== contents ||
    !event.senderFrame ||
    event.senderFrame !== contents.mainFrame
  )
    return null;
  try {
    if (new URL(event.senderFrame.url).origin !== new URL(appURL).origin)
      return null;
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { total, papers, books, failed } = value as Record<string, unknown>;
  const count = (item: unknown): item is number =>
    typeof item === "number" &&
    Number.isSafeInteger(item) &&
    item >= 0 &&
    item <= 10_000_000;
  if (
    !count(total) ||
    !count(papers) ||
    !count(books) ||
    papers + books > total ||
    typeof failed !== "boolean"
  )
    return null;
  return { total, papers, books, failed };
}

/** Best-effort, bounded diagnostics across launches; no library content is saved. */
export function createLibraryStartupLog(options: {
  userData: string;
  appDirectory: string;
  version: string;
  isPackaged: boolean;
  dataDir: string;
}) {
  const directory = join(options.userData, "logs");
  const path = join(directory, "library-startup.jsonl");
  const records: string[] = [];
  let queue = (async () => {
    await mkdir(directory, { recursive: true });
    try {
      // Do not read an unexpectedly large or externally modified file.
      if ((await stat(path)).size <= 128 * 1024)
        records.push(
          ...(await readFile(path, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .slice(-63),
        );
    } catch {
      // A first launch has no previous log.
    }
  })().catch(() => {});
  const write = (record: object) => {
    const line = JSON.stringify({ time: new Date().toISOString(), ...record });
    queue = queue
      .then(async () => {
        records.push(line);
        records.splice(0, Math.max(0, records.length - 64));
        await writeFile(path, records.join("\n") + "\n", "utf8");
      })
      .catch(() => {});
    return queue;
  };
  const ready = write({
    event: "startup",
    appDirectory: options.appDirectory,
    version: options.version,
    isPackaged: options.isPackaged,
    dataDir: options.dataDir,
  });
  let lastState = "";
  return {
    ready,
    recordState(state: LibraryState) {
      const { total, papers, books, failed } = state;
      const signature = JSON.stringify({ total, papers, books, failed });
      if (signature === lastState) return queue;
      lastState = signature;
      return write({ event: "library", total, papers, books, failed });
    },
  };
}
