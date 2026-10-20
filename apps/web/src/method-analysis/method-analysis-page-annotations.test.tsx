// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MethodAnalysisPage,
  type MethodAnalysisController,
  type MethodAnalysisReader,
} from "./MethodAnalysisPage";
import { methodAnalysisContentHash } from "./method-analysis-text";

vi.mock("../chat/MessageMarkdown", () => ({
  MessageMarkdown: ({ content }: { content: string }) => (
    <div className="message-markdown">
      <p>{content}</p>
    </div>
  ),
}));
let host: HTMLDivElement, root: Root;
const events = { selection: vi.fn(), annotation: vi.fn() };
const ready = vi.fn<(reader: MethodAnalysisReader | undefined) => void>();
const complete = (content = "已保存的方法解析"): MethodAnalysisController => ({
  job: { documentId: "paper", status: "complete", content, detail: "" },
  loading: false,
  pending: false,
  modelSaving: false,
  error: "",
  start: vi.fn(),
  cancel: vi.fn(),
  refresh: vi.fn(),
});
beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(analysis: MethodAnalysisController) {
  await act(async () =>
    root.render(
      <MethodAnalysisPage
        documentId="paper"
        analysis={analysis}
        events={events}
        onReady={ready}
      />,
    ),
  );
}
const current = () => ready.mock.calls.at(-1)?.[0];

it("waits for the initial saved-result request before exposing a reader", async () => {
  await render({ ...complete(), job: undefined, loading: true });
  expect(ready).not.toHaveBeenCalled();
  await render(complete());
  await vi.waitFor(() =>
    expect(current()?.getContext()).toBe("已保存的方法解析"),
  );
  const location = current()!.getLocation()!;
  expect(location.contentHash).toBe(
    await methodAnalysisContentHash("已保存的方法解析"),
  );
  expect(location.quote).toBe("已保存的方法解析");
});

it("exposes an explicit no-result error only after loading has finished", async () => {
  await render({ ...complete(), job: undefined, loading: true });
  await render({
    ...complete(),
    job: { documentId: "paper", status: "idle", content: "", detail: "" },
  });
  expect(current()).toBeDefined();
  await expect(
    current()!.focusLocation({
      type: "method-analysis",
      contentHash: "old",
      start: 0,
      end: 2,
      quote: "解析",
    }),
  ).rejects.toThrow("当前没有已保存的方法解析");
});

it("keeps saved content readable during regeneration and never binds the unfinished draft", async () => {
  const analysis = complete();
  await render({
    ...analysis,
    job: { ...analysis.job!, status: "running", draft: "未完成的新草稿" },
  });
  await vi.waitFor(() =>
    expect(current()?.getContext()).toBe("已保存的方法解析"),
  );
  expect(host.textContent).toContain("解析完成后可添加批注");
  const draft = host.querySelector(".method-analysis-draft p:last-child")!;
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(draft);
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
  expect(current()!.getSelection()).toBeNull();
  expect(events.selection).not.toHaveBeenCalledWith(
    expect.objectContaining({ text: "未完成的新草稿" }),
  );
  selection.removeAllRanges();
});

it("invalidates the previous reader when completed content changes and clears onReady on unmount", async () => {
  await render(complete("旧解析"));
  await vi.waitFor(() => expect(current()?.getContext()).toBe("旧解析"));
  const old = current()!;
  const oldLocation = old.getLocation()!;
  await render(complete("新解析"));
  await vi.waitFor(() => expect(current()?.getContext()).toBe("新解析"));
  await expect(old.focusLocation(oldLocation)).rejects.toThrow("已关闭");
  await expect(current()!.focusLocation(oldLocation)).rejects.toThrow(
    "之前的解析版本",
  );
  await act(async () => root.render(null));
  expect(ready).toHaveBeenLastCalledWith(undefined);
});
