// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTheme, type AIConfig } from "@reader/core";
import { api } from "@reader/api";
import { Settings } from "./Settings";
import { useReaderStore } from "./store";
import { saveReaderSettings } from "./reader-settings";

vi.mock("@reader/api", () => ({
  api: {
    connectorStatus: vi.fn(async () => ({ available: true })),
    providers: vi.fn(async () => []),
    aiConfig: vi.fn(),
    saveSettings: vi.fn(async (theme) => theme),
  },
}));
vi.mock("./TaskModels", () => ({ TaskModels: () => null }));
vi.mock("./ProviderIdentity", () => ({ ProviderIdentity: () => null }));
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
const render = async (open = true) => {
  await act(async () =>
    root.render(<Settings open={open} onOpenChange={() => {}} />),
  );
};
const promptField = () =>
  host.querySelector<HTMLTextAreaElement>('[aria-label="方法解析提示词"]')!;
const editPrompt = async (value: string) => {
  const field = promptField();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const checkbox = (text: string) =>
  [...host.querySelectorAll("label")]
    .find((label) => label.textContent?.includes(text))!
    .querySelector<HTMLButtonElement>('[role="checkbox"]')!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.clearAllMocks();
  const config: AIConfig = {
    primary: "",
    models: {},
    capabilities: {},
    api: { url: "", model: "", hasKey: false },
    textAPI: { url: "", model: "", hasKey: false },
    imageAPI: { url: "", model: "", hasKey: false },
  };
  vi.mocked(api.aiConfig).mockResolvedValue(config);
  useReaderStore.setState({
    theme: { ...defaultTheme },
    aiConfig: undefined,
    aiModelSaving: false,
    libraryPreferences: {},
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

it("saves the latest method requirements when settings close without blurring", async () => {
  await render();
  expect(promptField().value).toBe("");
  expect(promptField().maxLength).toBe(4000);
  await editPrompt("解释核心公式");
  await editPrompt("解释核心公式和伪代码\n结合软件安全场景举例");
  await render(false);

  // The desktop-close save reads the store even if the focused field never blurred.
  await saveReaderSettings(useReaderStore.getState().theme);
  const saved = vi.mocked(api.saveSettings).mock.lastCall![0];
  expect(api.saveSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({
      methodAnalysisPrompt: "解释核心公式和伪代码\n结合软件安全场景举例",
    }),
  );
  await act(async () => root.unmount());
  root = createRoot(host);
  useReaderStore.setState({ theme: { ...defaultTheme, ...saved } });
  await render();
  expect(promptField().value).toBe(
    "解释核心公式和伪代码\n结合软件安全场景举例",
  );

  await editPrompt("");
  await saveReaderSettings(useReaderStore.getState().theme);
  expect(api.saveSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ methodAnalysisPrompt: "" }),
  );
});

it("persists automatic method analysis independently from automatic translation", async () => {
  useReaderStore.setState({
    theme: { ...defaultTheme, autoTranslatePDF: false },
  });
  await render();
  expect(checkbox("导入后自动进行方法解析").getAttribute("aria-checked")).toBe(
    "false",
  );
  await act(async () => checkbox("导入后自动进行方法解析").click());
  expect(checkbox("导入后自动翻译").getAttribute("aria-checked")).toBe("false");
  await render(false);
  await saveReaderSettings(useReaderStore.getState().theme);
  const saved = vi.mocked(api.saveSettings).mock.lastCall![0];
  expect(saved).toMatchObject({
    autoAnalyzeMethods: true,
    autoTranslatePDF: false,
  });

  useReaderStore.setState({ theme: { ...defaultTheme, ...saved } });
  await render();
  expect(checkbox("导入后自动进行方法解析").getAttribute("aria-checked")).toBe(
    "true",
  );
  await act(async () => checkbox("导入后自动翻译").click());
  await act(async () => checkbox("导入后自动进行方法解析").click());
  await saveReaderSettings(useReaderStore.getState().theme);
  expect(api.saveSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({
      autoAnalyzeMethods: false,
      autoTranslatePDF: true,
    }),
  );
});
