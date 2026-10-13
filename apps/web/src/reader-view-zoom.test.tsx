// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultTheme, type Document, type ReaderTheme } from "@reader/core";
import { ReaderView } from "./ReaderView";

const setTheme = vi.fn(async (_theme: ReaderTheme) => {});
const open = vi.fn(async () => {});

vi.mock("./readers/pdf", () => ({
  PDFReaderAdapter: class {
    preferTheme() {}
    open = open;
    setTheme = setTheme;
    highlight = vi.fn(async () => {});
    getTOC = vi.fn(async () => []);
    destroy = vi.fn(async () => {});
    setBlocks() {}
  },
}));
vi.mock("./readers/epub-web", () => ({
  EPUBReaderAdapter: class {
    preferTheme() {}
    open = open;
    setTheme = setTheme;
    highlight = vi.fn(async () => {});
    getTOC = vi.fn(async () => []);
    destroy = vi.fn(async () => {});
    setBlocks() {}
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

let root: Root;
let host: HTMLDivElement;

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

it.each(["pdf", "epub"] as const)(
  "applies the latest theme when a slow %s finishes opening",
  async (type) => {
    let finish!: () => void;
    open.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const document = { id: type, type, title: type } as Document;
    const events = { location: () => {}, selection: () => {}, zoom: vi.fn() };
    const view = (theme: ReaderTheme) => (
      <ReaderView
        document={document}
        theme={theme}
        annotations={[]}
        onReady={() => {}}
        events={events}
      />
    );
    await act(async () => root.render(view(defaultTheme)));
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    const latest: ReaderTheme = {
      ...defaultTheme,
      mode: "cream",
      appearance: "cream",
      fontSize: 1.4,
      fontFamily: "sans-serif",
      zoom: 1.5,
    };
    await act(async () => root.render(view(latest)));
    await act(async () => finish());
    expect(setTheme).toHaveBeenLastCalledWith(
      type === "pdf" ? { ...latest, zoom: "width" } : latest,
    );
    if (type === "epub") expect(events.zoom).not.toHaveBeenCalled();
  },
);

it("does not reset another tab's zoom when an old PDF finishes theme setup after unmount", async () => {
  let finish!: () => void;
  setTheme.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const zoom = vi.fn();
  await act(async () =>
    root.render(
      <ReaderView
        document={{ id: "paper", type: "pdf" } as Document}
        theme={defaultTheme}
        annotations={[]}
        onReady={() => {}}
        events={{ zoom, location: () => {}, selection: () => {} }}
      />,
    ),
  );
  await vi.waitFor(() => expect(setTheme).toHaveBeenCalledOnce());
  await act(async () => root.render(null));
  await act(async () => finish());
  expect(zoom).not.toHaveBeenCalled();
});

it("fits a PDF to the pane width when it opens, even after a saved zoom", async () => {
  const zoom = vi.fn();
  const paper = { id: "paper", type: "pdf", title: "Paper" } as Document;
  await act(async () => {
    root.render(
      <ReaderView
        document={paper}
        theme={{ ...defaultTheme, zoom: 1.5 }}
        annotations={[]}
        onReady={() => {}}
        events={{
          zoom,
          location: () => {},
          selection: () => {},
        }}
      />,
    );
  });
  expect(setTheme).toHaveBeenCalledWith(
    expect.objectContaining({ zoom: "width" }),
  );
  expect(zoom).toHaveBeenCalledWith("width");
  expect(open).toHaveBeenCalledOnce();
});
