// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import type { Document } from "@reader/core";
import { useReaderStore } from "./store";
import { useLibraryLoad } from "./useLibraryLoad";

vi.mock("@reader/api", () => ({
  api: { documents: vi.fn(), providers: vi.fn(), aiConfig: vi.fn() },
}));

const papers = [
  { id: "saved-paper", title: "已保存的论文", library: "papers" },
] as Document[];
let root: Root, host: HTMLDivElement;
function Harness() {
  const { loading, initialized, error, retry } = useLibraryLoad();
  const documents = useReaderStore((state) => state.documents);
  return (
    <div data-initialized={initialized}>
      {loading ? <span role="status">正在读取</span> : null}
      {error ? <span role="alert">{error}</span> : null}
      <button onClick={retry}>重新读取</button>
      {documents.map((doc) => (
        <span key={doc.id}>{doc.title}</span>
      ))}
    </div>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useReaderStore.setState({
    documents: [],
    readingProgress: {},
    tabs: [],
    active: null,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const render = () => act(async () => root.render(<Harness />));
const advance = (ms: number) =>
  act(async () => vi.advanceTimersByTimeAsync(ms));

it("recovers a transient startup read failure without requiring an AI connection", async () => {
  vi.mocked(api.documents)
    .mockRejectedValueOnce(new Error("连接暂时中断"))
    .mockResolvedValue(papers);
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "连接暂时中断",
  );
  await advance(1000);
  expect(host.textContent).toContain("已保存的论文");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[role="status"]')).toBeNull();
  expect(api.providers).not.toHaveBeenCalled();
  expect(api.aiConfig).not.toHaveBeenCalled();
});

it("stops automatic retries after persistent failure and recovers on manual retry", async () => {
  vi.mocked(api.documents).mockRejectedValue(new Error("无法读取书库"));
  await render();
  await advance(60_000);
  expect(api.documents).toHaveBeenCalledTimes(3);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "无法读取书库",
  );
  vi.mocked(api.documents).mockResolvedValue(papers);
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(host.textContent).toContain("已保存的论文");
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("keeps existing library records when a refresh fails", async () => {
  useReaderStore.setState({ documents: papers });
  vi.mocked(api.documents).mockRejectedValue(new Error("offline"));
  await render();
  expect(host.textContent).toContain("已保存的论文");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("offline");
  expect(useReaderStore.getState().documents).toEqual(papers);
});

it("reports only library counts and failure state to desktop diagnostics", async () => {
  const reportLibraryState = vi.fn();
  vi.stubGlobal("readerDesktop", { reportLibraryState });
  vi.mocked(api.documents)
    .mockRejectedValueOnce(new Error("private failure details"))
    .mockResolvedValue(papers);
  await render();
  expect(reportLibraryState).toHaveBeenLastCalledWith({
    total: 0,
    papers: 0,
    books: 0,
    failed: true,
  });
  await advance(1000);
  expect(reportLibraryState).toHaveBeenLastCalledWith({
    total: 1,
    papers: 1,
    books: 0,
    failed: false,
  });
});

it("cancels scheduled retries on unmount", async () => {
  vi.mocked(api.documents).mockRejectedValue(new Error("offline"));
  await render();
  await act(async () => root.render(null));
  await advance(60_000);
  expect(api.documents).toHaveBeenCalledTimes(1);
});

it("keeps startup initialized while a later retry is pending", async () => {
  vi.mocked(api.documents).mockRejectedValueOnce(new Error("offline"));
  await render();
  expect(host.firstElementChild?.getAttribute("data-initialized")).toBe("true");
  let release!: (docs: Document[]) => void;
  vi.mocked(api.documents).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  expect(host.firstElementChild?.getAttribute("data-initialized")).toBe("true");
  await act(async () => release(papers));
  expect(host.textContent).toContain("已保存的论文");
});

it("does not let an older response replace a successful manual reload", async () => {
  let release!: (docs: Document[]) => void;
  vi.mocked(api.documents)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue(papers);
  await render();
  expect(host.querySelector('[role="status"]')).not.toBeNull();
  await act(async () =>
    host.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(host.textContent).toContain("已保存的论文");
  await act(async () => release([]));
  expect(useReaderStore.getState().documents).toEqual(papers);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
