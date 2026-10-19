// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { AICapability, AIConfig } from "@reader/core";
import { api } from "@reader/api";
import { Settings } from "./Settings";
import { useReaderStore } from "./store";

vi.mock("@reader/api", () => ({
  api: {
    connectorStatus: vi.fn(async () => ({ available: true })),
    providers: vi.fn(),
    aiConfig: vi.fn(),
    testAI: vi.fn(),
    agentModels: vi.fn(async () => []),
    saveLibraryPreferences: vi.fn(async (value) => value),
  },
}));
// Capability state changes do not depend on model-picker layout or brand avatars.
// Keep those independent render trees out of this lifecycle suite; TaskModels has
// its own interaction tests. Model changes below still use the real shared store.
vi.mock("./TaskModels", () => ({ TaskModels: () => null }));
vi.mock("./ProviderIdentity", () => ({
  ProviderIdentity: ({ provider }: { provider: string }) => (
    <span>{provider}</span>
  ),
}));
vi.mock("@reader/ui/components/dialog", () => {
  const Content = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogContent: Content,
    DialogHeader: Content,
    DialogTitle: Content,
    DialogDescription: Content,
  };
});
let root: Root;
let host: HTMLDivElement;
let config: AIConfig;
let complete: (capability: AICapability) => void;
const passed = { text: true, vision: true, checkedAt: "2026-10-05" };
const render = async (open = true) => {
  await act(async () =>
    root.render(<Settings open={open} onOpenChange={() => {}} />),
  );
};
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  config = {
    primary: "codex",
    models: {},
    capabilities: {},
    api: { url: "", model: "", hasKey: false },
    textAPI: { url: "", model: "", hasKey: false },
    imageAPI: { url: "", model: "", hasKey: false },
  };
  useReaderStore.setState({ aiConfig: undefined, aiModelSaving: false });
  vi.mocked(api.providers).mockResolvedValue([
    { id: "codex", installed: true, authenticated: true, status: "已登录" },
    { id: "claude", installed: false, authenticated: false, status: "未安装" },
  ]);
  vi.mocked(api.aiConfig).mockImplementation(async () => config);
  vi.mocked(api.testAI).mockImplementation((_id, stage) => {
    if (stage === "vision") return Promise.resolve(config.capabilities.codex);
    return new Promise((resolve) => {
      complete = (capability) => {
        config = { ...config, capabilities: { codex: capability } };
        resolve(capability);
      };
    });
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
it("automatically checks installed agents once, even when settings reopen during a check", async () => {
  await render();
  expect(api.testAI).toHaveBeenCalledExactlyOnceWith("codex", "text");
  expect(host.querySelector('[aria-label="文本推理：检测中"]')).not.toBeNull();
  expect(host.textContent).not.toContain("测试可用性与识图");
  expect(host.querySelector('[aria-label="图片理解：检测中"]')).not.toBeNull();
  await render(false);
  await render();
  expect(api.testAI).toHaveBeenCalledTimes(1);
  await act(async () => complete(passed));
  expect(host.querySelector('[data-state="passed"]')).not.toBeNull();
  await render(false);
  await render();
  expect(api.testAI).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[data-state="passed"]')).not.toBeNull();
});
it("shows independent text and image results and allows an explicit retry", async () => {
  await render();
  await act(async () =>
    complete({ ...passed, vision: false, error: "图片能力未通过检测" }),
  );
  expect(
    host.querySelector('[aria-label="文本推理：已通过"] [data-state="passed"]'),
  ).not.toBeNull();
  expect(
    host.querySelector('[aria-label="图片理解：未通过"] [data-state="failed"]'),
  ).not.toBeNull();
  await act(async () =>
    (
      host.querySelector('[aria-label="重新检测 Agent"]') as HTMLButtonElement
    ).click(),
  );
  expect(api.testAI).toHaveBeenCalledTimes(3);
  expect(host.querySelector('[data-state="pending"]')).not.toBeNull();
  await act(async () => complete(passed));
  expect(host.querySelector('[data-state="passed"]')).not.toBeNull();
});
it.each([passed, { ...passed, vision: false, error: "识图失败" }])(
  "reuses persisted results after settings remount until an explicit retry",
  async (capability) => {
    config = { ...config, capabilities: { codex: capability } };
    await render();
    expect(api.testAI).not.toHaveBeenCalled();
    expect(
      host.querySelector('[aria-label="文本推理：已通过"]'),
    ).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(api.testAI).not.toHaveBeenCalled();
    await act(async () =>
      (
        host.querySelector('[aria-label="重新检测 Agent"]') as HTMLButtonElement
      ).click(),
    );
    expect(api.testAI).toHaveBeenCalledExactlyOnceWith("codex", "text");
    await act(async () => complete(passed));
    expect(useReaderStore.getState().aiConfig?.capabilities.codex).toEqual(
      passed,
    );
  },
);
it("keeps a saved check visible while metadata loads and reflects global failures", async () => {
  config = { ...config, capabilities: { codex: passed } };
  useReaderStore.setState({ aiConfig: config });
  let finish!: (value: AIConfig) => void;
  vi.mocked(api.aiConfig).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await render();
  expect(host.querySelector('[aria-label="文本推理：已通过"]')).not.toBeNull();
  await act(async () => finish(config));
  await act(async () =>
    useReaderStore.getState().setAIConfig({
      ...config,
      capabilities: {
        codex: { ...passed, text: false, vision: false, error: "调用失败" },
      },
    }),
  );
  expect(host.querySelector('[aria-label="文本推理：未通过"]')).not.toBeNull();
  expect(api.testAI).not.toHaveBeenCalled();
});

it("publishes text while vision is still running, even without a subscription login", async () => {
  vi.mocked(api.providers).mockResolvedValue([
    {
      id: "codex",
      installed: true,
      authenticated: false,
      status: "登录状态未确认",
    },
  ]);
  let finishVision!: (capability: AICapability) => void;
  vi.mocked(api.testAI).mockImplementation((_id, stage) => {
    if (stage === "text")
      return Promise.resolve({ ...passed, vision: false, pendingVision: true });
    return new Promise((resolve) => {
      finishVision = resolve;
    });
  });
  await render();
  expect(api.providers).toHaveBeenCalledWith(false);
  expect(api.testAI).toHaveBeenNthCalledWith(1, "codex", "text");
  expect(api.testAI).toHaveBeenNthCalledWith(2, "codex", "vision");
  expect(host.querySelector('[aria-label="文本推理：已通过"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="图片理解：检测中"]')).not.toBeNull();
  await act(async () => finishVision(passed));
  expect(host.querySelector('[aria-label="图片理解：已通过"]')).not.toBeNull();
});

it("keeps successful text when the vision request disconnects", async () => {
  vi.mocked(api.testAI).mockImplementation(async (_id, stage) => {
    if (stage === "text")
      return { ...passed, vision: false, pendingVision: true };
    throw new Error("connection interrupted");
  });
  await render();
  expect(host.querySelector('[aria-label="文本推理：已通过"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="图片理解：未通过"]')).not.toBeNull();
});

it("resumes an interrupted vision check without repeating text", async () => {
  config.capabilities.codex = { ...passed, vision: false, pendingVision: true };
  vi.mocked(api.testAI).mockResolvedValue(passed);
  await render();
  expect(api.testAI).toHaveBeenCalledExactlyOnceWith("codex", "vision");
  expect(host.querySelector('[aria-label="文本推理：已通过"]')).not.toBeNull();
});

it("does not show old green checks after a text retry disconnects", async () => {
  config.capabilities.codex = passed;
  await render();
  vi.mocked(api.testAI).mockRejectedValue(new Error("connection interrupted"));
  await act(async () =>
    (
      host.querySelector('[aria-label="重新检测 Agent"]') as HTMLButtonElement
    ).click(),
  );
  expect(host.querySelector('[aria-label="文本推理：未通过"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="图片理解：已通过"]')).toBeNull();
});

it("checks a changed CLI model and checks it again after switching back", async () => {
  config.models = { codex: "model-a" };
  const failed = { ...passed, text: false, vision: false, error: "登录失效" };
  config.capabilities.claude = failed;
  vi.mocked(api.providers).mockResolvedValue([
    { id: "codex", installed: true, authenticated: true, status: "已登录" },
    { id: "claude", installed: true, authenticated: false, status: "登录失效" },
  ]);
  vi.mocked(api.testAI).mockImplementation(async (id) => {
    config = {
      ...config,
      capabilities: { ...config.capabilities, [id]: passed },
    };
    return passed;
  });
  await render();
  expect(api.testAI).toHaveBeenCalledTimes(2);
  const saveModel = async (model: string) => {
    const { codex: _, ...capabilities } = config.capabilities;
    config = { ...config, models: { codex: model }, capabilities };
    await act(async () => useReaderStore.getState().setAIConfig(config));
  };
  await saveModel("model-b");
  expect(api.testAI).toHaveBeenCalledTimes(4);
  await saveModel("model-a");
  expect(api.testAI).toHaveBeenCalledTimes(6);
  expect(host.querySelector('[aria-label="文本推理：已通过"]')).not.toBeNull();

  await render(false);
  await saveModel("model-b");
  await saveModel("model-a");
  expect(api.testAI).toHaveBeenCalledTimes(6);
  await render();
  expect(api.testAI).toHaveBeenCalledTimes(8);
  await render();
  expect(api.testAI).toHaveBeenCalledTimes(8);
  expect(vi.mocked(api.testAI).mock.calls.every(([id]) => id === "codex")).toBe(
    true,
  );
  expect(config.capabilities.claude).toEqual(failed);
});

it("does not repeat CLI checks for translation choices or saved failed checks", async () => {
  config.capabilities.codex = {
    ...passed,
    text: false,
    vision: false,
    error: "连接失败",
  };
  await render();
  config = { ...config, translationModels: { codex: "translation-model" } };
  await act(async () => useReaderStore.getState().setAIConfig(config));
  await render(false);
  await render();
  expect(api.testAI).not.toHaveBeenCalled();
});

it("distinguishes an untested model from a failed capability check", async () => {
  config.capabilities.codex = passed;
  await render();
  config = { ...config, capabilities: {} };
  await act(async () => useReaderStore.getState().setAIConfig(config));
  expect(host.querySelector('[aria-label="文本推理：未检测"]')).not.toBeNull();
  expect(host.textContent).toContain("文本推理 · 未检测");
  expect(host.querySelector('[aria-label="文本推理：未通过"]')).toBeNull();
  expect(api.testAI).not.toHaveBeenCalled();
});
