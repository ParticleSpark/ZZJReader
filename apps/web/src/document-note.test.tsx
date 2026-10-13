// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@reader/api";
import { toast } from "sonner";
import { DocumentNotePage } from "./DocumentNotePage";
import { NotesPanel } from "./NotesPanel";
import { paper } from "./papers/fixtures";
import {
  clearDocumentNotes,
  flushDocumentNotes,
  forgetDocumentNote,
  useDocumentNote,
} from "./document-note";

vi.mock("@reader/api", () => ({
  api: {
    documentNote: vi.fn(async () => ({ body: "" })),
    saveDocumentNote: vi.fn(async (_id: string, body: string) => ({ body })),
    saveNoteImage: vi.fn(async () => ({ id: `${"a".repeat(32)}.png` })),
    noteImage: vi.fn(
      async () => new Blob([Uint8Array.from([1])], { type: "image/png" }),
    ),
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  clearDocumentNotes();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.clearAllMocks();
  vi.mocked(api.documentNote).mockImplementation(async () => ({ body: "" }));
  vi.mocked(api.saveDocumentNote).mockImplementation(async (_id, body) => ({
    body,
  }));
  vi.mocked(api.saveNoteImage).mockImplementation(async () => ({
    id: `${"a".repeat(32)}.png`,
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
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

let draft: ReturnType<typeof useDocumentNote>;
function NoteHarness({ id = "paper-1" }: { id?: string }) {
  draft = useDocumentNote(id);
  return <output>{draft.body}</output>;
}

it("serializes saves and flush waits for newer edits behind an in-flight save", async () => {
  const first = deferred<{ body: string }>();
  const second = deferred<{ body: string }>();
  vi.mocked(api.saveDocumentNote)
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise);
  await act(async () => root.render(<NoteHarness />));
  await act(async () => draft.setBody("first", true));
  await act(async () => draft.setBody("second", true));
  expect(api.saveDocumentNote).toHaveBeenCalledExactlyOnceWith(
    "paper-1",
    "first",
  );
  let finished = false;
  const closing = flushDocumentNotes().then(() => {
    finished = true;
  });
  await act(async () => first.resolve({ body: "first" }));
  expect(api.saveDocumentNote).toHaveBeenNthCalledWith(2, "paper-1", "second");
  expect(finished).toBe(false);
  await act(async () => {
    second.resolve({ body: "second" });
    await closing;
  });
  expect(finished).toBe(true);
  expect(draft.body).toBe("second");
  expect(draft.status).toBe("saved");
});

it("keeps failed drafts without a retry loop and lets close report failure", async () => {
  vi.mocked(api.saveDocumentNote).mockRejectedValue(new Error("disk full"));
  await act(async () => root.render(<NoteHarness />));
  await act(async () => draft.setBody("unsaved", true));
  expect(draft.status).toBe("error");
  await act(async () => vi.advanceTimersByTime(8_000));
  expect(api.saveDocumentNote).toHaveBeenCalledOnce();
  expect(toast.error).toHaveBeenCalledOnce();
  await act(async () => {
    await expect(flushDocumentNotes()).rejects.toThrow("disk full");
  });
  expect(draft.body).toBe("unsaved");
  vi.mocked(api.saveDocumentNote).mockImplementation(async (_id, body) => ({
    body,
  }));
  await act(async () => draft.retry());
  expect(draft.status).toBe("saved");
});

it("does not replace an existing note when the initial read fails", async () => {
  vi.mocked(api.documentNote)
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce({ body: "existing notes" });
  await act(async () => root.render(<DocumentNotePage documentId="paper-1" />));
  const field = host.querySelector("textarea")!;
  expect(field.disabled).toBe(true);
  await act(async () => vi.advanceTimersByTime(2_000));
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  const retry = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "重试",
  )!;
  await act(async () => retry.click());
  expect(field.disabled).toBe(false);
  expect(field.value).toBe("existing notes");
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
});

const imageFile = () =>
  new File([Uint8Array.from([1])], "image.png", { type: "image/png" });
const pasteImage = (field: HTMLTextAreaElement) => {
  const file = imageFile();
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
    },
  });
  field.dispatchEvent(event);
};

it.each(["page", "panel"])(
  "preserves edits made in either editor while %s image upload is pending",
  async (editor) => {
    const upload = deferred<{ id: string }>();
    vi.mocked(api.documentNote).mockResolvedValue({ body: "initial" });
    vi.mocked(api.saveNoteImage).mockImplementationOnce(() => upload.promise);
    await act(async () =>
      root.render(
        <>
          <DocumentNotePage documentId="paper-1" />
          <NotesPanel
            document={paper({ id: "paper-1" })}
            annotations={[]}
            messages={[]}
            deleting={new Set()}
            answering={new Set()}
            onGo={() => {}}
            onDelete={() => {}}
            onSave={async () => true}
            onAnswer={() => {}}
            onResolve={() => {}}
            onShowAnswer={() => {}}
            onExport={() => {}}
          />
        </>,
      ),
    );
    const fields = host.querySelectorAll<HTMLTextAreaElement>(
      'textarea[aria-label="论文笔记"]',
    );
    expect(fields).toHaveLength(2);
    const source = fields[editor === "page" ? 0 : 1]!;
    source.setSelectionRange(0, source.value.length);
    await act(async () => pasteImage(source));
    await act(async () => type(fields[1]!, "new shared draft"));
    await act(async () => upload.resolve({ id: `${"b".repeat(32)}.png` }));
    const expected = `new shared draft\n\n![](note-image:${"b".repeat(32)}.png)`;
    expect(fields[0]!.value).toBe(expected);
    expect(fields[1]!.value).toBe(expected);
    expect(api.saveDocumentNote).toHaveBeenLastCalledWith("paper-1", expected);
  },
);

it("close waits for an image upload and its resulting note save", async () => {
  const upload = deferred<{ id: string }>();
  const save = deferred<{ body: string }>();
  vi.mocked(api.saveNoteImage).mockImplementationOnce(() => upload.promise);
  vi.mocked(api.saveDocumentNote).mockImplementationOnce(() => save.promise);
  await act(async () => root.render(<NoteHarness />));
  let pasting!: ReturnType<typeof draft.pasteImages>;
  await act(async () => {
    pasting = draft.pasteImages([imageFile()], 0, 0);
  });
  let finished = false;
  const closing = flushDocumentNotes().then(() => {
    finished = true;
  });
  expect(finished).toBe(false);
  await act(async () => {
    upload.resolve({ id: `${"a".repeat(32)}.png` });
    await pasting;
  });
  expect(finished).toBe(false);
  await act(async () => {
    save.resolve({ body: draft.body });
    await closing;
  });
  expect(finished).toBe(true);
  expect(draft.status).toBe("saved");
});

it("forgets a permanently deleted note before reimporting its content hash", async () => {
  vi.mocked(api.documentNote)
    .mockResolvedValueOnce({ body: "deleted old note" })
    .mockResolvedValueOnce({ body: "" });
  await act(async () => root.render(<NoteHarness />));
  expect(draft.body).toBe("deleted old note");
  await act(async () => root.render(null));
  forgetDocumentNote("paper-1");
  await act(async () => root.render(<NoteHarness />));
  expect(draft.body).toBe("");
  expect(api.documentNote).toHaveBeenCalledTimes(2);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  clearDocumentNotes();
  vi.useRealTimers();
});

const type = (el: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

it("saves one markdown note and renders the preview", async () => {
  await act(async () => root.render(<DocumentNotePage documentId="paper-1" />));
  const field = document.body.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="论文笔记"]',
  )!;
  await act(async () => type(field, "这是 **术语**"));
  expect(api.saveDocumentNote).not.toHaveBeenCalled();
  const preview = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "预览",
  )!;
  await act(async () => preview.click());
  await act(async () => {
    await vi.dynamicImportSettled?.();
  });
  expect(
    document.body.querySelector(".message-markdown strong")?.textContent,
  ).toBe("术语");
  await act(async () => vi.advanceTimersByTime(900));
  expect(api.saveDocumentNote).toHaveBeenCalledExactlyOnceWith(
    "paper-1",
    "这是 **术语**",
  );
});

it("pastes a clipboard image into the note and previews it", async () => {
  if (typeof URL.createObjectURL !== "function") {
    Object.assign(URL, {
      createObjectURL: () => "",
      revokeObjectURL: () => {},
    });
  }
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:note-image");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  await act(async () => root.render(<DocumentNotePage documentId="paper-1" />));
  const field = document.body.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="论文笔记"]',
  )!;
  const file = new File([Uint8Array.from([1, 2, 3])], "shot.png", {
    type: "image/png",
  });
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
      getData: () => "",
    },
  });
  await act(async () => {
    field.dispatchEvent(event);
  });
  const image = `![](note-image:${"a".repeat(32)}.png)`;
  expect(field.value).toBe(image);
  expect(api.saveNoteImage).toHaveBeenCalledOnce();
  const preview = [...document.body.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === "预览",
  )!;
  await act(async () => preview.click());
  await act(async () => {
    await vi.dynamicImportSettled?.();
  });
  expect(
    document.body.querySelector("img.note-image")?.getAttribute("src"),
  ).toBe("blob:note-image");
  expect(document.body.innerHTML).not.toContain("<script");
});
