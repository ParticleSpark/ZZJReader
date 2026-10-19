import { beforeEach, expect, it, vi } from "vitest";
import type { Document } from "@reader/core";
import { api } from "@reader/api";
import {
  forgetLibraryDocuments,
  refreshLibrary,
  useReaderStore,
} from "./store";

vi.mock("@reader/api", () => ({ api: { documents: vi.fn() } }));

const paper = (id: string) =>
  ({ id, title: id, library: "papers" }) as Document;
const saved = [paper("saved-paper")];
const newer = [...saved, paper("new-paper")];
function pendingRead() {
  let resolve!: (documents: Document[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Document[]>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  useReaderStore.setState({
    documents: [],
    readingProgress: {},
    tabs: [],
    active: null,
  });
});

it("shows a successful startup read while a later refresh is pending", async () => {
  const initial = pendingRead();
  const later = pendingRead();
  vi.mocked(api.documents)
    .mockReturnValueOnce(initial.promise)
    .mockReturnValueOnce(later.promise);
  const startup = refreshLibrary();
  const refreshing = refreshLibrary();

  initial.resolve(saved);
  await startup;
  expect(useReaderStore.getState().documents).toEqual(saved);

  const failure = expect(refreshing).rejects.toThrow("offline");
  later.reject(new Error("offline"));
  await failure;
  expect(useReaderStore.getState().documents).toEqual(saved);
});

it("accepts an earlier successful read after a newer request failed", async () => {
  const initial = pendingRead();
  vi.mocked(api.documents)
    .mockReturnValueOnce(initial.promise)
    .mockRejectedValueOnce(new Error("offline"));
  const startup = refreshLibrary();
  await expect(refreshLibrary()).rejects.toThrow("offline");

  initial.resolve(saved);
  await startup;
  expect(useReaderStore.getState().documents).toEqual(saved);
});

it("does not replace a newer successful snapshot with an older response", async () => {
  const initial = pendingRead();
  vi.mocked(api.documents)
    .mockReturnValueOnce(initial.promise)
    .mockResolvedValueOnce(newer);
  const startup = refreshLibrary();
  await refreshLibrary();

  initial.resolve([]);
  await startup;
  expect(useReaderStore.getState().documents).toEqual(newer);
});

it("does not restore removed documents even when a newer read fails", async () => {
  useReaderStore.getState().setDocuments(newer);
  const initial = pendingRead();
  vi.mocked(api.documents)
    .mockReturnValueOnce(initial.promise)
    .mockRejectedValueOnce(new Error("offline"));
  const refreshing = refreshLibrary();
  forgetLibraryDocuments(["saved-paper"]);
  await expect(refreshLibrary()).rejects.toThrow("offline");

  initial.resolve(newer);
  await refreshing;
  expect(useReaderStore.getState().documents).toEqual([paper("new-paper")]);
});

it("accepts a fresh empty library after local removals", async () => {
  useReaderStore.getState().setDocuments(newer);
  const initial = pendingRead();
  vi.mocked(api.documents)
    .mockReturnValueOnce(initial.promise)
    .mockResolvedValueOnce([]);
  const refreshing = refreshLibrary();
  forgetLibraryDocuments(["saved-paper"]);
  await refreshLibrary();

  initial.resolve(newer);
  await refreshing;
  expect(useReaderStore.getState().documents).toEqual([]);
});
