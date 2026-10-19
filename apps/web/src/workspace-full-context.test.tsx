// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, chat } from "@reader/api";
import {
  defaultTheme,
  type AIConfig,
  type Document,
  type ReaderAdapter,
  type ReaderEvents,
  type ReaderSelection,
  type ReaderTheme,
} from "@reader/core";
import { Workspace } from "./Workspace";
import { useReaderStore } from "./store";
import type { PDFReadingView } from "./translation/PDFReadingView";

const fixture = vi.hoisted(() => ({
  events: undefined as ReaderEvents | undefined,
  ready: undefined as
    ComponentProps<typeof PDFReadingView>["onReady"] | undefined,
}));
vi.mock("./translation/PDFReadingView", () => ({
  PDFReadingView: ({
    events,
    onReady,
  }: ComponentProps<typeof PDFReadingView>) => {
    fixture.events = events;
    fixture.ready = onReady;
    return <div />;
  },
}));
vi.mock("./translation/EPUBReadingView", () => ({
  EPUBReadingView: () => null,
}));
vi.mock("./chat/AssistantPanel", () => ({
  AssistantPanel: ({ empty }: { empty: ReactNode }) => <>{empty}</>,
}));
vi.mock("./NotesPanel", () => ({ NotesPanel: () => null }));
vi.mock("./ProcessingUsage", () => ({ ProcessingUsageDialog: () => null }));
vi.mock("./ExportNotesDialog", () => ({ ExportNotesDialog: () => null }));
vi.mock("./ModelSelector", () => ({ ModelSelector: () => null }));
vi.mock("@reader/api", () => ({
  api: {
    aiConfig: vi.fn(),
    annotations: vi.fn(async () => []),
    blocks: vi.fn(async () => []),
    messages: vi.fn(async () => []),
  },
  chat: vi.fn(),
  blockImageURL: vi.fn(),
}));
vi.mock("@reader/ui/components/resizable", () => {
  const Panel = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    ResizablePanelGroup: Panel,
    ResizablePanel: Panel,
    ResizableHandle: () => null,
    usePanelRef: () => ({ current: null }),
  };
});
vi.mock("@reader/ui/components/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const doc = {
  id: "paper",
  type: "pdf",
  title: "Paper",
  library: "papers",
} as Document;
const selected: ReaderSelection = {
  text: "A selected sentence.",
  location: { type: "pdf", page: 2 },
  anchor: { x: 100, top: 40, bottom: 60 },
};
const adapter = {
  getContext: vi.fn(async () => "Current page content."),
  getLocation: () => ({ type: "pdf", page: 2 }),
  clearSelection: vi.fn(),
} as unknown as ReaderAdapter;
function Harness() {
  const theme = useReaderStore((state) => state.theme);
  return <Workspace document={doc} theme={theme} onSettings={() => {}} />;
}
let root: Root;
let host: HTMLDivElement;
const button = (label: string) =>
  host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
const click = (label: string) => act(async () => button(label).click());
const render = async (theme: ReaderTheme = defaultTheme) => {
  useReaderStore.setState({ theme });
  await act(async () => root.render(<Harness />));
  await act(async () => fixture.ready!(adapter, []));
};
const askSelection = async () => {
  await act(async () => fixture.events!.selection(selected));
  await click("问 AI");
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(chat).mockResolvedValue(undefined);
  vi.mocked(api.aiConfig).mockResolvedValue({ primary: "codex" } as AIConfig);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  useReaderStore.setState({
    theme: defaultTheme,
    aiConfig: undefined,
    aiModelSaving: false,
    linkTarget: null,
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

it("keeps full paper context off for legacy settings and sends only the selection", async () => {
  const { chatFullDocument: _omitted, ...legacy } = defaultTheme;
  await render(legacy);
  expect(button("全文上下文").getAttribute("aria-pressed")).toBe("false");
  await askSelection();
  expect(chat).toHaveBeenCalledTimes(1);
  expect(vi.mocked(chat).mock.calls[0]![3]).toContain(selected.text);
  expect(vi.mocked(chat).mock.calls[0]![10]).toBe(false);
  expect(adapter.getContext).not.toHaveBeenCalled();
});

it("adds full context to selection questions, locks it during a response, and allows opting out next time", async () => {
  await render();
  await click("全文上下文");
  expect(useReaderStore.getState().theme.chatFullDocument).toBe(true);
  expect(button("全文上下文").getAttribute("aria-pressed")).toBe("true");
  let finish!: () => void;
  vi.mocked(chat).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await askSelection();
  expect(vi.mocked(chat).mock.calls[0]![10]).toBe(true);
  expect(vi.mocked(chat).mock.calls[0]![3]).toContain(selected.text);
  expect(button("全文上下文").disabled).toBe(true);
  await click("全文上下文");
  expect(useReaderStore.getState().theme.chatFullDocument).toBe(true);
  await act(async () => finish());
  expect(button("全文上下文").disabled).toBe(false);
  await click("全文上下文");
  await askSelection();
  expect(vi.mocked(chat).mock.calls[1]![10]).toBe(false);
  expect(useReaderStore.getState().theme.chatFullDocument).toBe(false);
});

it("restores the saved preference and applies it to current-page starter questions", async () => {
  await render({ ...defaultTheme, chatFullDocument: true });
  expect(button("全文上下文").getAttribute("aria-pressed")).toBe("true");
  const starter = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.includes("总结当前页面"),
  )!;
  await act(async () => starter.click());
  expect(vi.mocked(chat).mock.calls[0]![3]).toBe("Current page content.");
  expect(vi.mocked(chat).mock.calls[0]![10]).toBe(true);
  expect(adapter.getContext).toHaveBeenCalledOnce();
});
