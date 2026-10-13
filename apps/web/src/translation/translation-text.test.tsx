// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranslationText } from "./TranslationText";
import { flushTranslationEdits } from "./translation-saves";

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it.each([
  "Algorithm 1: Read phase\n1     Function read(txn, record)\n2         latch(record)",
  "Algorithm 2: use ``` and `x` inside",
])("renders algorithm text as a code block: %s", async (text) => {
  // The assertion measures rendering, not the first compilation of Markdown's
  // dynamic dependency graph on a busy Windows test worker.
  await import("../chat/MessageMarkdown");
  await act(async () =>
    root.render(
      <TranslationText
        block={{ id: "p7-b9", label: "algorithm", text }}
        documentId="doc"
        retry={() => {}}
      />,
    ),
  );
  await vi.waitFor(() =>
    expect(host.querySelector(".translation-algorithm pre code")).toBeTruthy(),
  );
  expect(
    host.querySelector(".translation-algorithm pre code")?.textContent,
  ).toBe(`${text}\n`);
});

it("retranslates a finished paragraph and saves a double-clicked sentence", async () => {
  const retranslate = vi.fn();
  const onSave = vi.fn(async () => {});
  await act(async () =>
    root.render(
      <TranslationText
        block={{ id: "p1-b1", label: "text", text: "First sentence." }}
        documentId="doc"
        retry={() => {}}
        retranslate={retranslate}
        onSave={onSave}
        translation={{
          blockId: "p1-b1",
          sourceHash: "h",
          status: "complete",
          sentences: [{ source: "First sentence.", target: "第一句。" }],
        }}
      />,
    ),
  );
  const button = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === "重新翻译",
  );
  expect(button).toBeTruthy();
  await act(async () => button!.click());
  expect(retranslate).toHaveBeenCalledOnce();
  await act(async () =>
    host
      .querySelector(".translation-sentence")!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  const editor = host.querySelector("textarea");
  expect(editor?.getAttribute("aria-label")).toBe("编辑译文");
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setValue.call(editor, "改过。");
    editor!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => editor!.blur());
  expect(onSave).toHaveBeenCalledWith(0, "改过。", {
    sourceHash: "h",
    source: "First sentence.",
    target: "第一句。",
  });
});

async function editableParagraph(
  onSave: NonNullable<React.ComponentProps<typeof TranslationText>["onSave"]>,
  firstTarget = "第一句。",
  strict = false,
) {
  const paragraph = (
    <TranslationText
      block={{
        id: "p1-b1",
        label: "text",
        text: "First sentence. Second sentence.",
      }}
      documentId="doc"
      retry={() => {}}
      onSave={onSave}
      translation={{
        blockId: "p1-b1",
        sourceHash: "original-hash",
        status: "complete",
        sentences: [
          { source: "First sentence.", target: firstTarget },
          { source: "Second sentence.", target: "第二句。" },
        ],
      }}
    />
  );
  await act(async () =>
    root.render(strict ? <StrictMode>{paragraph}</StrictMode> : paragraph),
  );
}

async function beginEdit(index: number, value: string) {
  await act(async () =>
    host
      .querySelector(`[data-sentence="${index}"]`)!
      .dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
  );
  const editor = document.activeElement as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(editor, value);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return editor;
}

it("keeps the next sentence's draft when an earlier save finishes", async () => {
  let finishFirst!: () => void;
  const onSave = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
  );
  await editableParagraph(onSave);
  const first = await beginEdit(0, "第一句的修改");
  await act(async () => first.blur());
  const second = await beginEdit(1, "第二句尚未保存");
  await act(async () => finishFirst());
  expect(second.isConnected).toBe(true);
  expect(second.value).toBe("第二句尚未保存");
  expect(host.querySelectorAll("textarea")).toHaveLength(1);
  expect(onSave).toHaveBeenCalledTimes(1);
});

it("keeps failed drafts and allows retry without losing another editor", async () => {
  let failFirst!: (error: Error) => void;
  const onSave = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        failFirst = reject;
      }),
  );
  await editableParagraph(onSave);
  const first = await beginEdit(0, "不能丢掉的修改");
  await act(async () => first.blur());
  const second = await beginEdit(1, "另一句的草稿");
  await act(async () => failFirst(new Error("保存失败")));
  expect(first.isConnected).toBe(true);
  expect(first.value).toBe("不能丢掉的修改");
  expect(first.readOnly).toBe(false);
  expect(second.value).toBe("另一句的草稿");
});

it("submits the sentence version from the start of editing after a stream update", async () => {
  const onSave = vi.fn(async () => {});
  await editableParagraph(onSave);
  const editor = await beginEdit(0, "基于旧版的修改");
  await editableParagraph(onSave, "服务器刚重译的句子");
  await act(async () => editor.blur());
  expect(onSave).toHaveBeenCalledWith(0, "基于旧版的修改", {
    sourceHash: "original-hash",
    source: "First sentence.",
    target: "第一句。",
  });
});

it("cancels a draft with Escape without saving it", async () => {
  const onSave = vi.fn(async () => {});
  await editableParagraph(onSave);
  const editor = await beginEdit(0, "不要保存");
  await act(async () =>
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    ),
  );
  expect(host.querySelector("textarea")).toBeNull();
  await act(async () => flushTranslationEdits());
  expect(onSave).not.toHaveBeenCalled();
});

it("waits for a submitted sentence after its editor unmounts", async () => {
  let finish!: () => void;
  const onSave = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await editableParagraph(onSave);
  const editor = await beginEdit(0, "提交后立即关闭");
  await act(async () => editor.blur());
  await act(async () => root.render(null));
  let closed = false;
  const closing = flushTranslationEdits().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(onSave).toHaveBeenCalledOnce();
  await act(async () => {
    finish();
    await closing;
  });
  expect(closed).toBe(true);
});

it("submits the focused draft on keyboard close without duplicate StrictMode saves", async () => {
  let finish!: () => void;
  const onSave = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await editableParagraph(onSave, "第一句。", true);
  const editor = await beginEdit(0, "尚未失焦的修改");
  expect(document.activeElement).toBe(editor);
  expect(onSave).not.toHaveBeenCalled();
  let first!: Promise<void>, second!: Promise<void>;
  await act(async () => {
    first = flushTranslationEdits();
    second = flushTranslationEdits();
  });
  expect(onSave).toHaveBeenCalledExactlyOnceWith(0, "尚未失焦的修改", {
    sourceHash: "original-hash",
    source: "First sentence.",
    target: "第一句。",
  });
  await act(async () => {
    finish();
    await Promise.all([first, second]);
  });
  expect(host.querySelector("textarea")).toBeNull();
});

it("rejects close on a failed sentence save and keeps the draft for retry", async () => {
  const onSave = vi
    .fn()
    .mockRejectedValueOnce(new Error("保存失败"))
    .mockResolvedValue(undefined);
  await editableParagraph(onSave);
  const editor = await beginEdit(0, "必须保留的修改");
  await act(async () => {
    await expect(flushTranslationEdits()).rejects.toThrow("保存失败");
  });
  expect(editor.isConnected).toBe(true);
  expect(editor.value).toBe("必须保留的修改");
  expect(editor.readOnly).toBe(false);
  await act(async () => flushTranslationEdits());
  expect(onSave).toHaveBeenCalledTimes(2);
  expect(host.querySelector("textarea")).toBeNull();
});
