import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Document, DocumentLocation } from "@reader/core";
import {
  forgetLibraryDocuments,
  openLinkTarget,
  useReaderStore,
} from "./store";
import { activateReaderTab, closeReaderTab } from "./reader-tabs";
import { flushProgress, scheduleProgress } from "./progress";
import { api } from "@reader/api";

vi.mock("@reader/api", () => ({ api: { update: vi.fn(async () => ({})) } }));

const doc = (id: string, title = id) => ({ id, title }) as Document;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useReaderStore.setState({
    documents: [],
    tabs: [],
    active: null,
    navigationRevision: 0,
    readingProgress: {},
  });
});
afterEach(async () => {
  vi.mocked(api.update).mockResolvedValue({} as Document);
  await flushProgress();
  vi.useRealTimers();
});

it("keeps each opened paper as a tab and returns to the library without closing them", () => {
  const { open } = useReaderStore.getState();
  open(doc("a", "Alpha"));
  open(doc("b", "Beta"));
  open(doc("a", "Alpha"));
  expect(useReaderStore.getState().tabs.map((tab) => tab.id)).toEqual([
    "a",
    "b",
  ]);
  expect(useReaderStore.getState().active?.id).toBe("a");
  open(null);
  expect(useReaderStore.getState().active).toBeNull();
  expect(useReaderStore.getState().tabs.map((tab) => tab.id)).toEqual([
    "a",
    "b",
  ]);
});

it("activates the neighbor when the current tab closes", () => {
  const { open, closeTab } = useReaderStore.getState();
  open(doc("a"));
  open(doc("b"));
  open(doc("c"));
  closeTab("b");
  expect(useReaderStore.getState().active?.id).toBe("c");
  closeTab("c");
  expect(useReaderStore.getState().tabs.map((tab) => tab.id)).toEqual(["a"]);
  expect(useReaderStore.getState().active?.id).toBe("a");
  closeTab("a");
  expect(useReaderStore.getState().active).toBeNull();
});

it("drops a trashed paper from the tabs and keeps another one open", () => {
  const { open } = useReaderStore.getState();
  open(doc("a"));
  open(doc("b"));
  useReaderStore.setState({ documents: [doc("a"), doc("b")] });
  forgetLibraryDocuments(["b"]);
  expect(useReaderStore.getState().tabs.map((tab) => tab.id)).toEqual(["a"]);
  expect(useReaderStore.getState().active?.id).toBe("a");
  expect(useReaderStore.getState().documents.map((item) => item.id)).toEqual([
    "a",
  ]);
});

const locations: DocumentLocation[] = [
  { type: "pdf", page: 10, x: 0.2, y: 0.4 },
  {
    type: "epub",
    href: "part/chapter2.xhtml",
    blockId: "chapter2-p4",
    start: 17,
    progression: 0.4,
  },
];

it.each(locations)(
  "keeps the latest $type location across tabs before the debounce expires",
  async (progress) => {
    const a = { ...doc("a"), type: progress.type, percentage: 0 };
    const b = doc("b");
    const state = useReaderStore.getState();
    state.setDocuments([a, b]);
    state.open(b);
    state.open(a);
    scheduleProgress("a", { progress, percentage: 0.4 }, () => {});
    expect(api.update).not.toHaveBeenCalled();
    for (const snapshot of [
      useReaderStore.getState().active,
      ...useReaderStore.getState().tabs,
      ...useReaderStore.getState().documents,
    ]) {
      if (snapshot?.id === "a") expect(snapshot.progress).toEqual(progress);
    }
    await activateReaderTab("b");
    expect(api.update).toHaveBeenCalledExactlyOnceWith("a", {
      progress,
      percentage: 0.4,
    });
    await activateReaderTab("a");
    expect(useReaderStore.getState().active?.progress).toEqual(progress);
    // Even a stale click closure must not restore an earlier snapshot.
    state.open(a);
    expect(useReaderStore.getState().active?.progress).toEqual(progress);
  },
);

it("keeps both PDF and EPUB positions when closing the active tab activates its neighbor", async () => {
  const state = useReaderStore.getState();
  state.open(doc("a"));
  scheduleProgress("a", { progress: locations[0], percentage: 0.4 }, () => {});
  await activateReaderTab("b", doc("b"));
  scheduleProgress("b", { progress: locations[1], percentage: 0.7 }, () => {});
  await closeReaderTab("b");
  expect(useReaderStore.getState().active?.progress).toEqual(locations[0]);
  expect(api.update).toHaveBeenLastCalledWith("b", {
    progress: locations[1],
    percentage: 0.7,
  });
  await activateReaderTab("b", doc("b"));
  expect(useReaderStore.getState().active?.progress).toEqual(locations[1]);
});

it("does not let an older library response erase session positions", () => {
  const state = useReaderStore.getState();
  const original = {
    ...doc("a"),
    progress: { type: "pdf" as const, page: 1 },
    percentage: 0,
  };
  state.setDocuments([original]);
  state.open(original);
  scheduleProgress("a", { progress: locations[0], percentage: 0.4 }, () => {});
  state.setDocuments([{ ...original, title: "Updated metadata" }]);
  const current = useReaderStore.getState();
  for (const snapshot of [
    current.active,
    current.tabs[0],
    current.documents[0],
  ]) {
    expect(snapshot?.progress).toEqual(locations[0]);
    expect(snapshot?.title).toBe("Updated metadata");
  }
});

it("keeps the last selection when the reader clicks A to B to A during a slow save", async () => {
  let acknowledge!: () => void;
  vi.mocked(api.update).mockImplementationOnce(
    () =>
      new Promise<Document>((resolve) => {
        acknowledge = () => resolve(doc("a"));
      }),
  );
  const state = useReaderStore.getState();
  state.open(doc("b"));
  state.open(doc("a"));
  scheduleProgress("a", { progress: locations[0], percentage: 0.4 }, () => {});
  const toB = activateReaderTab("b");
  const backToA = activateReaderTab("a");
  await vi.advanceTimersByTimeAsync(0);
  expect(useReaderStore.getState().active?.id).toBe("a");
  acknowledge();
  expect(await toB).toBe(false);
  expect(await backToA).toBe(true);
  expect(useReaderStore.getState().active?.progress).toEqual(locations[0]);
});

it("retains the current tab and its newest location if saving fails", async () => {
  vi.mocked(api.update).mockRejectedValueOnce(new Error("offline"));
  const state = useReaderStore.getState();
  state.open(doc("b"));
  state.open(doc("a"));
  scheduleProgress("a", { progress: locations[0], percentage: 0.4 }, () => {});
  await expect(activateReaderTab("b")).rejects.toThrow("offline");
  expect(useReaderStore.getState().active?.id).toBe("a");
  expect(useReaderStore.getState().active?.progress).toEqual(locations[0]);
  await activateReaderTab("b");
  expect(useReaderStore.getState().active?.id).toBe("b");
});

it("does not reopen a tab closed while its activation waits for a save", async () => {
  let acknowledge!: () => void;
  vi.mocked(api.update).mockImplementationOnce(
    () =>
      new Promise<Document>((resolve) => {
        acknowledge = () => resolve(doc("a"));
      }),
  );
  const state = useReaderStore.getState();
  state.setDocuments([doc("a"), doc("b")]);
  state.open(doc("b"));
  state.open(doc("a"));
  scheduleProgress("a", { progress: locations[0], percentage: 0.4 }, () => {});
  const toB = activateReaderTab("b");
  await vi.advanceTimersByTimeAsync(0);
  await closeReaderTab("b");
  acknowledge();
  expect(await toB).toBe(false);
  expect(useReaderStore.getState().active?.id).toBe("a");
  expect(useReaderStore.getState().tabs.map((tab) => tab.id)).toEqual(["a"]);
});

it("honors the last selection after closing the active tab temporarily activates its neighbor", async () => {
  let acknowledge!: () => void;
  vi.mocked(api.update).mockImplementationOnce(
    () =>
      new Promise<Document>((resolve) => {
        acknowledge = () => resolve(doc("a"));
      }),
  );
  const state = useReaderStore.getState();
  state.open(doc("a"));
  state.open(doc("b"));
  state.open(doc("c"));
  state.open(doc("a"));
  scheduleProgress("a", { progress: locations[0], percentage: 0.4 }, () => {});
  const closing = closeReaderTab("a");
  const toC = activateReaderTab("c");
  await vi.advanceTimersByTimeAsync(0);
  acknowledge();
  await closing;
  expect(await toC).toBe(true);
  expect(useReaderStore.getState().active?.id).toBe("c");
  expect(useReaderStore.getState().tabs.map((tab) => tab.id)).toEqual([
    "b",
    "c",
  ]);
});

it("does not replace a newer reader link with an older pending tab selection", async () => {
  let acknowledge!: () => void;
  vi.mocked(api.update).mockImplementationOnce(
    () =>
      new Promise<Document>((resolve) => {
        acknowledge = () => resolve(doc("a"));
      }),
  );
  const state = useReaderStore.getState();
  const linked = { ...doc("linked"), library: "papers" as const };
  state.setDocuments([doc("a"), doc("c"), linked]);
  state.open(doc("c"));
  state.open(doc("a"));
  scheduleProgress("a", { progress: locations[0], percentage: 0.4 }, () => {});
  const toC = activateReaderTab("c");
  await vi.advanceTimersByTimeAsync(0);
  expect(await openLinkTarget({ id: linked.id, page: 7 })).toBe(true);
  acknowledge();
  expect(await toC).toBe(false);
  expect(useReaderStore.getState().active?.id).toBe(linked.id);
  expect(useReaderStore.getState().linkTarget).toEqual({
    id: linked.id,
    page: 7,
  });
});
