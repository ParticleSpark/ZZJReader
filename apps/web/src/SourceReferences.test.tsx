// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DocumentLocation, Message, ReaderAdapter } from "@reader/core";
import { SourceReferences } from "./SourceReferences";

const location: DocumentLocation = {
  type: "method-analysis",
  contentHash: "a".repeat(64),
  start: 8,
  end: 28,
  quote: "A method explanation",
};
const message: Message = {
  id: "message",
  documentId: "paper",
  role: "user",
  content: "Explain this step.",
  createdAt: "",
  references: [{ text: "A method explanation", location, kind: "selection" }],
};
let root: Root;
let host: HTMLDivElement;
const navigate = vi.fn(
  async (_location: DocumentLocation, _text: string) => {},
);
const search = vi.fn<ReaderAdapter["search"]>(async () => []);
const flashReference = vi.fn();
const adapter = { search, flashReference } as unknown as ReaderAdapter;

const render = async (
  props: {
    message?: Message;
    adapter?: ReaderAdapter;
  } = {},
) => {
  await act(async () => {
    root.render(
      <SourceReferences
        message={props.message ?? message}
        toc={[]}
        adapter={props.adapter}
        onNavigate={navigate}
      />,
    );
  });
};
const clickCard = async () => {
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".reference-card")!.click();
  });
};

beforeEach(() => {
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

it("opens saved analysis references without requiring the original reader adapter", async () => {
  await render();
  expect(host.textContent).toContain("引用方法解析 · 重点句");
  expect(host.textContent).not.toContain("原文");
  expect(host.textContent).not.toContain("第 1 页");
  expect(
    host.querySelector<HTMLButtonElement>(".reference-card")!.disabled,
  ).toBe(false);
  await clickCard();
  expect(navigate).toHaveBeenCalledWith(location, "A method explanation");
});

it("never searches or flashes the original paper for an analysis reference", async () => {
  await render({ adapter });
  await clickCard();
  expect(navigate).toHaveBeenCalledWith(location, "A method explanation");
  expect(search).not.toHaveBeenCalled();
  expect(flashReference).not.toHaveBeenCalled();
});

it("surfaces a stale analysis error without falling back to a paper search and permits retry", async () => {
  navigate.mockRejectedValueOnce(new Error("方法解析已更新，无法定位旧引用。"));
  await render({ adapter });
  await clickCard();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "方法解析已更新，无法定位旧引用。",
  );
  expect(search).not.toHaveBeenCalled();
  expect(flashReference).not.toHaveBeenCalled();
  await clickCard();
  expect(navigate).toHaveBeenCalledTimes(2);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("retains original-document labels and saved-location highlighting", async () => {
  const original: DocumentLocation = { type: "pdf", page: 3 };
  await render({
    adapter,
    message: {
      ...message,
      references: [{ text: "Paper evidence", location: original }],
    },
  });
  expect(host.textContent).toContain("引用原文 · 第 3 页 · 重点句");
  await clickCard();
  expect(navigate).toHaveBeenCalledWith(original, "Paper evidence");
  expect(flashReference).toHaveBeenCalledWith(original, "Paper evidence");
  expect(search).not.toHaveBeenCalled();
});

it("requires a reader for locationless historical excerpts and searches them when available", async () => {
  const legacy: Message = {
    ...message,
    references: undefined,
    context: "Paper evidence",
  };
  await render({ message: legacy });
  expect(
    host.querySelector<HTMLButtonElement>(".reference-card")!.disabled,
  ).toBe(true);
  const original: DocumentLocation = { type: "pdf", page: 7 };
  search.mockResolvedValueOnce([
    { id: "match", excerpt: "Paper evidence", location: original },
  ]);
  await render({ adapter, message: legacy });
  await clickCard();
  expect(search).toHaveBeenCalledWith("Paper evidence");
  expect(navigate).toHaveBeenCalledWith(original, "Paper evidence");
  expect(flashReference).toHaveBeenCalledWith(original, "Paper evidence");
});
