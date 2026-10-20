// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import {
  defaultTheme,
  type MethodAnalysis,
  type ReaderTheme,
} from "@reader/core";
import { MethodAnalysisPage } from "./MethodAnalysisPage";
import { useMethodAnalysis } from "./useMethodAnalysis";
import { useReaderStore } from "../store";

vi.mock("@reader/api", () => ({
  api: {
    methodAnalysis: vi.fn(),
    startMethodAnalysis: vi.fn(),
    cancelMethodAnalysis: vi.fn(),
    saveSettings: vi.fn(),
  },
}));
vi.mock("../chat/MessageMarkdown", () => ({
  MessageMarkdown: ({ content }: { content: string }) => <p>{content}</p>,
}));

const result = (
  status: MethodAnalysis["status"],
  content = "",
  documentId = "paper-a",
): MethodAnalysis => ({
  documentId,
  status,
  content,
  detail: "",
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
let root: Root, host: HTMLDivElement;
let analysis: ReturnType<typeof useMethodAnalysis>;
function Harness({
  id = "paper-a",
  enabled = true,
}: {
  id?: string;
  enabled?: boolean;
}) {
  analysis = useMethodAnalysis(id, enabled);
  return enabled ? (
    <MethodAnalysisPage documentId={id} analysis={analysis} />
  ) : null;
}
async function render(id = "paper-a", enabled = true) {
  await act(async () => root.render(<Harness id={id} enabled={enabled} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.resetAllMocks();
  useReaderStore.setState({ aiModelSaving: false, theme: defaultTheme });
  vi.mocked(api.saveSettings).mockImplementation(async (theme) => theme);
  vi.mocked(api.methodAnalysis).mockResolvedValue(result("idle"));
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

it("loads saved results on opening without starting AI and does not poll completed results", async () => {
  vi.mocked(api.methodAnalysis).mockResolvedValue(
    result("complete", "已保存的完整解析"),
  );
  await render("paper-a", false);
  expect(api.methodAnalysis).not.toHaveBeenCalled();
  await render();
  expect(host.textContent).toContain("已保存的完整解析");
  expect(api.startMethodAnalysis).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(10000));
  expect(api.methodAnalysis).toHaveBeenCalledOnce();
  await render("paper-a", false);
  await render();
  expect(api.methodAnalysis).toHaveBeenCalledTimes(2);
  expect(api.startMethodAnalysis).not.toHaveBeenCalled();
});

it("only queries queued and running tasks, stops when hidden and resumes from saved state", async () => {
  vi.mocked(api.methodAnalysis)
    .mockResolvedValueOnce(result("queued"))
    .mockResolvedValueOnce({
      ...result("running"),
      detail: "正在读取论文全文",
      draft: "方法第一步",
    })
    .mockResolvedValue(result("complete", "完整结果"));
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(host.textContent).toContain("正在读取论文全文");
  expect(host.textContent).toContain("本次解析 · 生成中");
  await render("paper-a", false);
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect(api.methodAnalysis).toHaveBeenCalledTimes(2);
  expect(api.cancelMethodAnalysis).not.toHaveBeenCalled();
  await render();
  expect(host.textContent).toContain("完整结果");
  expect(api.startMethodAnalysis).not.toHaveBeenCalled();
});

it("rejects late query and mutation responses when switching papers", async () => {
  const oldQuery = deferred<MethodAnalysis>();
  const oldStart = deferred<MethodAnalysis>();
  vi.mocked(api.methodAnalysis)
    .mockImplementationOnce(() => oldQuery.promise)
    .mockResolvedValue(result("complete", "论文 B 的解析", "paper-b"));
  vi.mocked(api.startMethodAnalysis).mockImplementationOnce(
    () => oldStart.promise,
  );
  await render();
  let starting!: Promise<void>;
  await act(async () => {
    starting = analysis.start();
  });
  await render("paper-b");
  await act(async () => {
    oldQuery.resolve(result("complete", "论文 A 的旧解析"));
    oldStart.resolve(result("running", "论文 A 的新解析"));
    await starting;
  });
  expect(host.textContent).toContain("论文 B 的解析");
  expect(host.textContent).not.toContain("论文 A");
  expect(analysis.pending).toBe(false);
});

it("deduplicates start clicks and ignores a stale read across a start request", async () => {
  const oldQuery = deferred<MethodAnalysis>();
  const start = deferred<MethodAnalysis>();
  vi.mocked(api.methodAnalysis)
    .mockImplementationOnce(() => oldQuery.promise)
    .mockResolvedValue(result("running"));
  vi.mocked(api.startMethodAnalysis).mockImplementationOnce(
    () => start.promise,
  );
  await render();
  let starting!: Promise<void>;
  await act(async () => {
    starting = analysis.start();
    void analysis.start();
  });
  expect(api.startMethodAnalysis).toHaveBeenCalledExactlyOnceWith(
    "paper-a",
    false,
  );
  await act(async () => oldQuery.resolve(result("complete", "旧查询")));
  expect(host.textContent).not.toContain("旧查询");
  await act(async () => {
    start.resolve(result("queued"));
    await starting;
  });
  expect(analysis.job?.status).toBe("running");
});

it("retains the last complete result and a visible error when reanalysis fails to start", async () => {
  vi.mocked(api.methodAnalysis).mockResolvedValue(
    result("complete", "原解析必须保留"),
  );
  vi.mocked(api.startMethodAnalysis).mockRejectedValue(
    new Error("模型暂不可用"),
  );
  await render();
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "重新解析",
  )!;
  await act(async () => button.click());
  expect(api.startMethodAnalysis).toHaveBeenCalledExactlyOnceWith(
    "paper-a",
    true,
  );
  expect(host.textContent).toContain("原解析必须保留");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "模型暂不可用",
  );
});

it("keeps the previous result and marks partial output unfinished after cancellation", async () => {
  const canceled = {
    ...result("canceled", "之前完整的解析"),
    draft: "本次只有一部分",
  };
  vi.mocked(api.methodAnalysis).mockResolvedValue({
    ...canceled,
    status: "running",
  });
  vi.mocked(api.cancelMethodAnalysis).mockImplementation(async () => {
    vi.mocked(api.methodAnalysis).mockResolvedValue(canceled);
    return canceled;
  });
  await render();
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "取消解析",
  )!;
  await act(async () => button.click());
  expect(api.cancelMethodAnalysis).toHaveBeenCalledExactlyOnceWith("paper-a");
  expect(host.textContent).toContain("之前完整的解析");
  expect(host.textContent).toContain("本次只有一部分");
  expect(host.textContent).toContain("本次解析 · 未完成");
  expect(host.textContent).toContain("方法解析已取消");
});

it("preserves content through a transient query error and recovers without starting another task", async () => {
  vi.mocked(api.methodAnalysis)
    .mockResolvedValueOnce(result("running", "已完成的旧解析"))
    .mockRejectedValueOnce(new Error("连接暂时中断"))
    .mockResolvedValue(result("complete", "最新完整解析"));
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(host.textContent).toContain("已完成的旧解析");
  expect(host.textContent).toContain("连接暂时中断");
  await act(async () => vi.advanceTimersByTimeAsync(1500));
  expect(host.textContent).toContain("最新完整解析");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(api.startMethodAnalysis).not.toHaveBeenCalled();
});

it("discards in-flight reads after unmount without canceling the background analysis", async () => {
  const query = deferred<MethodAnalysis>();
  vi.mocked(api.methodAnalysis).mockImplementation(() => query.promise);
  await render();
  await act(async () => root.unmount());
  root = createRoot(host);
  await act(async () => query.resolve(result("running")));
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect(api.methodAnalysis).toHaveBeenCalledOnce();
  expect(api.cancelMethodAnalysis).not.toHaveBeenCalled();
});

it("saves the latest prompt before starting and does not start when settings fail to save", async () => {
  useReaderStore.setState({
    theme: {
      ...useReaderStore.getState().theme,
      methodAnalysisPrompt: "请详细解释复杂度",
    },
  });
  vi.mocked(api.saveSettings).mockRejectedValue(new Error("设置未能保存"));
  await render();
  await act(async () => analysis.start());
  expect(api.saveSettings).toHaveBeenCalledWith(
    expect.objectContaining({ methodAnalysisPrompt: "请详细解释复杂度" }),
  );
  expect(api.startMethodAnalysis).not.toHaveBeenCalled();
  expect(host.textContent).toContain("设置未能保存");
});

it("prevents starts while the AI model is being saved", async () => {
  useReaderStore.setState({ aiModelSaving: true });
  await render();
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "开始解析",
  )!;
  expect(button.disabled).toBe(true);
  await act(async () => analysis.start());
  expect(api.startMethodAnalysis).not.toHaveBeenCalled();
  expect(api.saveSettings).not.toHaveBeenCalled();
});

it("does not start the old document when switching while its settings save is pending", async () => {
  const saving = deferred<ReaderTheme>();
  vi.mocked(api.saveSettings).mockImplementationOnce(() => saving.promise);
  await render();
  let starting!: Promise<void>;
  await act(async () => {
    starting = analysis.start();
  });
  await render("paper-b");
  await act(async () => {
    saving.resolve(defaultTheme);
    await starting;
  });
  expect(api.startMethodAnalysis).not.toHaveBeenCalled();
});

it("renders the completed answer only once even if a response retains its last draft", async () => {
  vi.mocked(api.methodAnalysis).mockResolvedValue({
    ...result("complete", "最终方法解析"),
    draft: "最终方法解析",
  });
  await render();
  expect(
    host.querySelector('[aria-label="已保存的方法解析"]')?.textContent,
  ).toBe("最终方法解析");
  expect(host.querySelector('[aria-label="尚未完成的方法解析"]')).toBeNull();
});

it("reports an initial read failure and lets the user reload without starting AI", async () => {
  vi.mocked(api.methodAnalysis)
    .mockRejectedValueOnce(new Error("服务器暂不可用"))
    .mockResolvedValue(result("complete", "恢复后的完整解析"));
  await render();
  expect(host.querySelector('[role="status"]')?.textContent).toBe(
    "方法解析暂时无法读取",
  );
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "重新加载",
  )!;
  await act(async () => button.click());
  expect(host.textContent).toContain("恢复后的完整解析");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(api.startMethodAnalysis).not.toHaveBeenCalled();
});
