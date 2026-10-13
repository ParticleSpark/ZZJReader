// @vitest-environment jsdom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  defaultTheme,
  type Annotation,
  type Document,
  type ReaderEvents,
  type ReaderSelection,
  type ReaderTheme,
} from "@reader/core";
import { Workspace } from "./Workspace";
import { copyText } from "./chat/clipboard";
import { useReaderStore } from "./store";
import type { PDFReadingView } from "./translation/PDFReadingView";

const fixture = vi.hoisted(() => ({
  events: undefined as ReaderEvents | undefined,
}));
vi.mock("./translation/PDFReadingView", () => ({
  PDFReadingView: ({ events }: ComponentProps<typeof PDFReadingView>) => {
    fixture.events = events;
    return <div />;
  },
}));
vi.mock("./translation/EPUBReadingView", () => ({
  EPUBReadingView: () => null,
}));
vi.mock("./chat/AssistantPanel", () => ({ AssistantPanel: () => null }));
vi.mock("./NotesPanel", () => ({ NotesPanel: () => null }));
vi.mock("./ProcessingUsage", () => ({ ProcessingUsageDialog: () => null }));
vi.mock("./ExportNotesDialog", () => ({ ExportNotesDialog: () => null }));
vi.mock("./ModelSelector", () => ({ ModelSelector: () => null }));
vi.mock("./chat/clipboard", () => ({ copyText: vi.fn(async () => true) }));
vi.mock("@reader/api", () => ({
  api: {
    aiConfig: vi.fn(async () => undefined),
    annotations: vi.fn(async () => [annotation]),
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
  location: { type: "pdf", page: 1 },
  anchor: { x: 100, top: 40, bottom: 60 },
};
const annotation: Annotation = {
  id: "highlight",
  documentId: doc.id,
  kind: "highlight",
  quote: "A saved quotation.",
  note: "",
  location: { type: "pdf", page: 2 },
  color: "#fef08a",
  createdAt: "2026-10-12",
};
let root: Root;
let host: HTMLDivElement;
const render = (theme: ReaderTheme) =>
  act(async () =>
    root.render(
      <Workspace
        document={doc}
        theme={theme}
        onSettings={() => {}}
      />,
    ),
  );
const select = (value: ReaderSelection | null = selected) =>
  act(async () => fixture.events!.selection(value));
const activateAnnotation = () =>
  act(async () =>
    fixture.events!.annotation!({
      ids: [annotation.id],
      anchor: selected.anchor!,
    }),
  );
beforeEach(() => {
  vi.clearAllMocks();
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

it("leaves the clipboard alone by default while retaining explicit copy for selections and annotations", async () => {
  await render(defaultTheme);
  await select();
  expect(copyText).not.toHaveBeenCalled();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="复制"]')!.click(),
  );
  expect(copyText).toHaveBeenLastCalledWith(selected.text, "已复制");
  vi.mocked(copyText).mockClear();
  await select(null);
  await activateAnnotation();
  expect(copyText).not.toHaveBeenCalled();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="复制"]')!.click(),
  );
  expect(copyText).toHaveBeenLastCalledWith(annotation.quote, "已复制");
});

it("copies each new selection and clicked annotation only while the preference is enabled", async () => {
  await render({ ...defaultTheme, autoCopySelection: true });
  await select();
  await select();
  expect(copyText).toHaveBeenCalledExactlyOnceWith(selected.text, "已复制");
  await select(null);
  await select();
  expect(copyText).toHaveBeenCalledTimes(2);
  await select(null);
  await activateAnnotation();
  expect(copyText).toHaveBeenLastCalledWith(annotation.quote, "已复制");
  vi.mocked(copyText).mockClear();
  await render({ ...defaultTheme, autoCopySelection: false });
  await select();
  await activateAnnotation();
  expect(copyText).not.toHaveBeenCalled();
  await render({ ...defaultTheme, autoCopySelection: true });
  await select();
  expect(copyText).toHaveBeenCalledExactlyOnceWith(selected.text, "已复制");
});

it("keeps older saved preferences without autoCopySelection opted out", async () => {
  const { autoCopySelection: _omitted, ...legacy } = defaultTheme;
  await render(legacy);
  await select();
  await select(null);
  await activateAnnotation();
  expect(copyText).not.toHaveBeenCalled();
});
