// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("./progress", () => ({
  flushProgress: vi.fn(async () => void calls.push("progress")),
}));
vi.mock("./document-note", () => ({
  flushDocumentNotes: vi.fn(async () => void calls.push("notes")),
}));
vi.mock("./translation/translation-saves", () => ({
  flushTranslationEdits: vi.fn(async () => void calls.push("translation")),
}));
vi.mock("@reader/api", () => ({
  api: {
    saveSettings: vi.fn(async () => void calls.push("settings")),
  },
}));
vi.mock("./store", () => ({
  useReaderStore: { getState: () => ({ theme: { mode: "light" } }) },
}));
import { installCloseFlush } from "./close-flush";
import { flushDocumentNotes } from "./document-note";
import { flushTranslationEdits } from "./translation/translation-saves";

afterEach(() => {
  calls.length = 0;
  Object.defineProperty(window, "readerDesktop", {
    configurable: true,
    value: undefined,
  });
});

it("answers the desktop close request without any React tree", async () => {
  let close: (() => Promise<void>) | undefined;
  const remove = vi.fn();
  Object.defineProperty(window, "readerDesktop", {
    configurable: true,
    value: {
      onBeforeClose: (callback: () => Promise<void>) => {
        close = callback;
        return remove;
      },
    },
  });
  const uninstall = installCloseFlush();
  await close!();
  expect(calls).toEqual(["progress", "notes", "translation", "settings"]);
  window.dispatchEvent(new Event("pagehide"));
  expect(calls).toEqual([
    "progress",
    "notes",
    "translation",
    "settings",
    "progress",
    "notes",
    "translation",
  ]);
  uninstall();
  expect(remove).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("pagehide"));
  expect(calls).toHaveLength(7);
});

it.each([
  ["notes", flushDocumentNotes],
  ["translation", flushTranslationEdits],
] as const)(
  "waits for pending %s and reports failures before allowing desktop close",
  async (_label, flush) => {
    let close: (() => Promise<void>) | undefined;
    let finish!: () => void;
    vi.mocked(flush).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    Object.defineProperty(window, "readerDesktop", {
      configurable: true,
      value: {
        onBeforeClose: (callback: () => Promise<void>) => {
          close = callback;
        },
      },
    });
    const uninstall = installCloseFlush();
    let closed = false;
    const pending = close!().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(calls).not.toContain("settings");
    finish();
    await pending;
    expect(closed).toBe(true);
    vi.mocked(flush).mockRejectedValueOnce(new Error("save failed"));
    await expect(close!()).rejects.toThrow("save failed");
    uninstall();
  },
);
