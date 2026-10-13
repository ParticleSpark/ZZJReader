// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import { ExportNotesDialog } from "./ExportNotesDialog";
import { clearDocumentNotes, useDocumentNote } from "./document-note";
import { downloadText } from "./download";
import { copyText } from "./chat/clipboard";
import { paper } from "./papers/fixtures";

vi.mock("@reader/api", () => ({
  api: {
    documentNote: vi.fn(async () => ({ body: "saved note" })),
    saveDocumentNote: vi.fn(async (_id: string, body: string) => ({ body })),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("./download", () => ({ downloadText: vi.fn() }));
vi.mock("./chat/clipboard", () => ({ copyText: vi.fn(async () => true) }));

let root: Root;
let host: HTMLDivElement;
let note: ReturnType<typeof useDocumentNote>;
const onClose = vi.fn();
function Editor() {
  note = useDocumentNote("p");
  return null;
}
const render = () =>
  root.render(
    <>
      <Editor />
      <ExportNotesDialog
        document={paper()}
        annotations={[]}
        messages={[]}
        onClose={onClose}
      />
    </>,
  );
const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === text,
  )!;

beforeEach(() => {
  clearDocumentNotes();
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  vi.mocked(api.documentNote).mockImplementation(async () => ({
    body: "saved note",
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearDocumentNotes();
  vi.useRealTimers();
});

it("exports and copies the shared draft before its autosave", async () => {
  await act(async () => render());
  await act(async () => note.setBody("new unfinished draft"));
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  await act(async () => button("复制").click());
  expect(copyText).toHaveBeenCalledWith(
    expect.stringContaining("new unfinished draft"),
    "已复制 Markdown",
  );
  await act(async () => button("导出").click());
  expect(downloadText).toHaveBeenCalledWith(
    expect.stringContaining("new unfinished draft"),
    expect.stringMatching(/-notes\.md$/),
    "text/markdown",
  );
  expect(api.documentNote).toHaveBeenCalledOnce();
});

it("keeps export disabled after a failed read until retry loads the existing note", async () => {
  vi.mocked(api.documentNote).mockRejectedValueOnce(new Error("unavailable"));
  await act(async () => render());
  expect(button("复制").disabled).toBe(true);
  expect(button("导出").disabled).toBe(true);
  await act(async () => button("导出").click());
  expect(downloadText).not.toHaveBeenCalled();
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  await act(async () => button("重试").click());
  expect(button("导出").disabled).toBe(false);
  await act(async () => button("导出").click());
  expect(downloadText).toHaveBeenCalledWith(
    expect.stringContaining("saved note"),
    expect.any(String),
    "text/markdown",
  );
});

it.each([false, true])(
  "explains missing image files only when the exported note contains images: %s",
  async (images) => {
    const body = images
      ? `text\n\n![](note-image:${"a".repeat(32)}.png)`
      : "text only";
    vi.mocked(api.documentNote).mockResolvedValueOnce({ body });
    await act(async () => render());
    expect(
      document.body.textContent?.includes(
        "粘贴的图片仅在 Reader 内显示，Markdown 导出不包含图片文件",
      ),
    ).toBe(images);
  },
);
