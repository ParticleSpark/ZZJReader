// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PDFBlock, Processing, TranslationBlock } from "@reader/core";
import { TranslationText } from "./TranslationText";
let host: HTMLDivElement, root: Root;
const base: PDFBlock = {
  id: "p1-b1",
  page: 1,
  label: "table",
  text: "INTERNAL CELLS 66.7 58.6",
  image: "assets/p1-b1.png",
  bounds: { x: 0, y: 0, width: 1, height: 1 },
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  await import("../chat/MessageMarkdown");
  await import("./FormulaFragment");
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
async function render(
  block: PDFBlock,
  translation?: TranslationBlock,
  formulaNumber?: string,
  processing?: Processing,
) {
  await act(async () =>
    root.render(
      <TranslationText
        block={block}
        formulaNumber={formulaNumber}
        translation={translation}
        processing={processing}
        documentId="doc"
        retry={() => {}}
      />,
    ),
  );
  for (
    let i = 0;
    i < 80 &&
    host.querySelector(".translation-formula") == null &&
    translation?.formulaMarkdown;
    i++
  ) {
    if (
      host.querySelector("img") &&
      translation.formulaMarkdown.includes("\\unknown")
    )
      break;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
}
it.each(["text", "display_formula"])(
  "shows actual job state for unfinished %s without claiming queued work is running",
  async (label) => {
    const block = {
      ...base,
      label,
      image: label === "text" ? undefined : base.image,
    };
    const pending: TranslationBlock = {
      blockId: block.id,
      sourceHash: "hash",
      status: "pending",
      sentences: [],
    };
    const job: Processing = {
      documentId: "doc",
      phase: "translating",
      status: "running",
      enabled: true,
      pagesDone: 21,
      pagesTotal: 21,
      translationsDone: 0,
      translationsTotal: 153,
      detail: "",
      updatedAt: "2026-10-14T00:00:00Z",
    };
    await render(block, pending, undefined, job);
    expect(host.textContent).toContain(
      label === "text" ? "等待翻译" : "等待公式转换",
    );
    expect(host.textContent).not.toContain("转换中");
    expect(host.textContent).not.toContain("翻译中");
    for (const [status, message] of [
      ["waiting", "等待 AI 配置"],
      ["failed", "翻译已停止"],
    ] as const) {
      await render(block, pending, undefined, {
        ...job,
        translating: { status, detail: "主 Agent 尚未通过所需能力测试" },
      });
      expect(host.textContent).toContain(message);
      expect(host.textContent).not.toContain("转换中");
      expect(host.textContent).not.toContain("翻译中");
    }
    await render(block, { ...pending, status: "running" }, undefined, job);
    expect(host.textContent).toContain(
      label === "text" ? "正在翻译中" : "公式转换中",
    );
    await render(block, { ...pending, status: "running" }, undefined, {
      ...job,
      status: "queued",
    });
    expect(host.textContent).toContain(
      label === "text" ? "等待翻译" : "等待公式转换",
    );
    expect(host.textContent).not.toContain("转换中");
    expect(host.textContent).not.toContain("翻译中");
    await render(block, { ...pending, status: "running" }, undefined, {
      ...job,
      enabled: false,
      status: "paused",
      translating: { status: "running", detail: "旧状态" },
    });
    expect(host.textContent).toContain("翻译已暂停");
    expect(host.textContent).not.toContain("转换中");
    expect(host.textContent).not.toContain("翻译中");
  },
);

it("preserves completed paragraphs while later work waits or fails and missing records are loading", async () => {
  const block = { ...base, label: "text", image: undefined };
  await render(block);
  expect(host.textContent).toContain("正在读取翻译状态");
  expect(host.textContent).not.toContain("正在翻译中");
  for (const status of ["waiting", "failed", "paused"] as const) {
    await render(
      block,
      {
        blockId: block.id,
        sourceHash: "hash",
        status: "complete",
        sentences: [{ source: "Saved sentence.", target: "保留已完成译文。" }],
      },
      undefined,
      {
        documentId: "doc",
        phase: "translating",
        status,
        enabled: status !== "paused",
        pagesDone: 21,
        pagesTotal: 21,
        translationsDone: 1,
        translationsTotal: 153,
        detail: "",
        updatedAt: "2026-10-14T00:00:00Z",
      },
    );
    expect(host.textContent).toContain("保留已完成译文。");
    expect(host.querySelector(".translation-pending")).toBeNull();
  }
});

it.each(["table", "chart", "image"])(
  "keeps %s body out of the translation view",
  async (label) => {
    await render({ ...base, label });
    expect(host.querySelector("img")).not.toBeNull();
    expect(host.textContent).not.toContain("INTERNAL");
    expect(host.textContent).not.toContain("正在翻译");
  },
);
it("renders only the translated caption alongside the table image", async () => {
  const caption = "Table 5. Results.";
  await render(
    { ...base, caption },
    {
      blockId: base.id,
      sourceHash: "test",
      status: "complete",
      sentences: [{ source: caption, target: "表 5. 结果。" }],
    },
  );
  expect(host.querySelector("img")).not.toBeNull();
  expect(host.textContent).toContain("表 5. 结果。");
  expect(host.textContent).not.toContain("INTERNAL");
});
it("inserts the formula-only Markdown at the formula block", async () => {
  await render(
    { ...base, label: "display_formula" },
    {
      blockId: base.id,
      sourceHash: "formula",
      status: "complete",
      sentences: [],
      formulaMarkdown: "$$\nS(i,j)=\\frac{1}{2}\\log p_R(j\\mid i)\n$$\n",
    },
  );
  for (let i = 0; i < 80 && !host.querySelector(".katex-display"); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 25));
    });
  }
  expect(host.querySelector(".katex-display")).not.toBeNull();
  expect(host.querySelector(".katex-error")).toBeNull();
  expect(host.querySelector("details img")).not.toBeNull();
  expect(host.querySelector("details")?.open).toBe(false);
});
it("retains the original formula image for invalid LaTeX", async () => {
  await render(
    { ...base, label: "display_formula" },
    {
      blockId: base.id,
      sourceHash: "formula",
      status: "complete",
      sentences: [],
      formulaMarkdown: "$$\n\\unknowncommand{x}\n$$\n",
    },
  );
  expect(host.querySelector("img")).not.toBeNull();
  expect(host.querySelector(".katex-error")).toBeNull();
  expect(host.querySelector(".translation-formula")).toBeNull();
});

it.each(["$$\n x=1\n$$", "$$\n\\unknowncommand{x}\n$$", ""])(
  "keeps the equation number in the formula row: %s",
  async (formulaMarkdown) => {
    await render(
      { ...base, label: "display_formula" },
      formulaMarkdown
        ? {
            blockId: base.id,
            sourceHash: "formula",
            status: "complete",
            sentences: [],
            formulaMarkdown,
          }
        : undefined,
      "(6)",
    );
    const row = host.querySelector(".translation-formula-row");
    expect(row?.querySelector(".translation-formula-number")?.textContent).toBe(
      "(6)",
    );
    expect(row?.querySelector(".translation-formula-content")).not.toBeNull();
    expect(host.querySelectorAll(".translation-formula-number")).toHaveLength(
      1,
    );
    expect(
      host.querySelector("details .translation-formula-number"),
    ).toBeNull();
  },
);

it("replaces the formula image placeholder when an asynchronous result arrives", async () => {
  const block = { ...base, label: "display_formula" };
  await render(
    block,
    {
      blockId: block.id,
      sourceHash: "formula",
      status: "running",
      sentences: [],
    },
    "(6)",
  );
  expect(host.querySelector(".translation-formula-row img")).not.toBeNull();
  expect(host.textContent).toContain("公式转换中");
  await render(
    block,
    {
      blockId: block.id,
      sourceHash: "formula",
      status: "complete",
      sentences: [],
      formulaMarkdown: "$$x=1$$",
    },
    "(6)",
  );
  expect(host.querySelector(".translation-formula-row .katex")).not.toBeNull();
  expect(host.querySelector(".translation-formula-row img")).toBeNull();
  expect(host.textContent).not.toContain("公式转换中");
  expect(host.querySelector(".translation-formula-number")?.textContent).toBe(
    "(6)",
  );
});
it("retains the placeholder and exposes an independent retry after failure", async () => {
  const retry = vi.fn();
  await act(async () =>
    root.render(
      <TranslationText
        block={{ ...base, label: "display_formula" }}
        translation={{
          blockId: base.id,
          sourceHash: "formula",
          status: "failed",
          sentences: [],
          error: "图片识别失败",
        }}
        documentId="doc"
        retry={retry}
      />,
    ),
  );
  expect(host.querySelector("img")).not.toBeNull();
  expect(host.textContent).toContain("图片识别失败");
  await act(async () => host.querySelector("button")?.click());
  expect(retry).toHaveBeenCalledOnce();
});
it("replaces a loaded layout crop with a display-sized render", async () => {
  vi.stubGlobal("devicePixelRatio", 2);
  const renderImage = vi.fn(async () => "blob:sharp");
  await act(async () =>
    root.render(
      <TranslationText
        block={base}
        documentId="doc"
        retry={() => {}}
        renderImage={renderImage}
      />,
    ),
  );
  const image = host.querySelector("img")!;
  expect(image.getAttribute("src")).toContain("assets/p1-b1.png");
  Object.defineProperty(image, "naturalWidth", { value: 480 });
  Object.defineProperty(image, "clientWidth", { value: 300 });
  await act(async () => {
    image.dispatchEvent(new Event("load"));
  });
  expect(renderImage).toHaveBeenCalledWith("p1-b1", 600);
  expect(image.getAttribute("src")).toBe("blob:sharp");
  // Keeps the crop's layout width so small figures are not enlarged.
  expect(image.getAttribute("width")).toBe("480");
  await act(async () => {
    image.dispatchEvent(new Event("load"));
  });
  expect(renderImage).toHaveBeenCalledTimes(1);
});
