import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  DocumentLocation,
  MethodAnalysisLocation,
  ReaderAdapter,
  ReaderSelection,
} from "@reader/core";
import type { MethodAnalysisReader } from "./method-analysis/MethodAnalysisReader";
import { MethodReaderBridge } from "./method-reader-bridge";

const analysisLocation: MethodAnalysisLocation = {
  type: "method-analysis",
  contentHash: "a".repeat(64),
  start: 10,
  end: 28,
};
const selected: ReaderSelection = {
  text: "Method explanation",
  location: { ...analysisLocation, quote: "Method explanation" },
};
const paperLocation: DocumentLocation = { type: "pdf", page: 5 };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function setup(open = false) {
  let visible = open;
  const show = vi.fn((next: boolean) => {
    visible = next;
  });
  const source = {
    open: vi.fn(async () => {}),
    getTOC: vi.fn(async () => []),
    getLocation: vi.fn(() => paperLocation),
    goTo: vi.fn(async (_location: DocumentLocation) => {}),
    next: vi.fn(async () => {}),
    previous: vi.fn(async () => {}),
    search: vi.fn(async () => []),
    getSelection: vi.fn(() => ({
      text: "Paper evidence",
      location: paperLocation,
    })),
    clearSelection: vi.fn(),
    highlight: vi.fn(async () => {}),
    setTheme: vi.fn(async () => {}),
    getContext: vi.fn(async () => "Full paper text"),
    destroy: vi.fn(async () => {}),
    focusLocation: vi.fn(async (_location: DocumentLocation) => {}),
    focusReference: vi.fn(
      async (_location: DocumentLocation, _text: string) => true,
    ),
    flashReference: vi.fn(),
    prepareAnnotation: vi.fn(async (selection: ReaderSelection) => selection),
    isNear: vi.fn(() => true),
  } satisfies ReaderAdapter;
  const analysis = {
    getSelection: vi.fn(() => selected),
    clearSelection: vi.fn(),
    focusLocation: vi.fn(async (_location: MethodAnalysisLocation) => {}),
    getContext: vi.fn(() => "# Saved method explanation"),
    getLocation: vi.fn(() => analysisLocation),
  } satisfies MethodAnalysisReader;
  const bridge = new MethodReaderBridge(() => visible, show);
  return {
    source,
    analysis,
    bridge,
    show,
    facade: bridge.wrap(source),
    visible: () => visible,
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it.each(["goTo", "focusLocation"] as const)(
  "%s opens a closed analysis and waits for its ready reader before completing",
  async (method) => {
    const { facade, bridge, analysis, source, visible, show } = setup();
    const focus = deferred();
    analysis.focusLocation.mockReturnValueOnce(focus.promise);
    const finished = vi.fn();
    const navigation = facade[method]!(analysisLocation).then(finished);
    expect(show).toHaveBeenCalledWith(true);
    expect(visible()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(analysis.focusLocation).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    bridge.register(analysis);
    expect(analysis.focusLocation).toHaveBeenCalledWith(analysisLocation);
    expect(finished).not.toHaveBeenCalled();
    focus.resolve();
    await navigation;
    expect(finished).toHaveBeenCalledOnce();
    expect(source.goTo).not.toHaveBeenCalled();
    expect(source.focusLocation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("routes a saved analysis reference and supplies its exact excerpt when the location has no quote", async () => {
  const { facade, bridge, analysis, source } = setup();
  const navigation = facade.focusReference!(analysisLocation, selected.text);
  bridge.register(analysis);
  await expect(navigation).resolves.toBe(true);
  expect(analysis.focusLocation).toHaveBeenCalledWith(selected.location);
  facade.flashReference!(analysisLocation, selected.text);
  expect(source.focusReference).not.toHaveBeenCalled();
  expect(source.flashReference).not.toHaveBeenCalled();
  expect(source.search).not.toHaveBeenCalled();
  expect(source.goTo).not.toHaveBeenCalled();
});

it.each([
  { type: "pdf", page: 8 },
  { type: "epub", href: "chapter.xhtml", progression: 0.4 },
] satisfies DocumentLocation[])(
  "returns to the $type source through focusLocation and closes the analysis overlay",
  async (location) => {
    const { facade, bridge, analysis, source, visible } = setup(true);
    bridge.register(analysis);
    await facade.focusLocation!(location);
    expect(visible()).toBe(false);
    expect(analysis.clearSelection).toHaveBeenCalledOnce();
    expect(source.focusLocation).toHaveBeenCalledExactlyOnceWith(location);
    expect(source.goTo).not.toHaveBeenCalled();
    expect(facade.getLocation()).toEqual(paperLocation);
    expect(await facade.getContext()).toBe("Full paper text");
  },
);

it("delegates original reference focus after closing the overlay and preserves its result", async () => {
  const { facade, bridge, analysis, source, visible } = setup(true);
  bridge.register(analysis);
  source.focusReference.mockResolvedValueOnce(false);
  await expect(
    facade.focusReference!(paperLocation, "Paper evidence"),
  ).resolves.toBe(false);
  expect(visible()).toBe(false);
  expect(source.focusReference).toHaveBeenCalledWith(
    paperLocation,
    "Paper evidence",
  );
  expect(analysis.focusLocation).not.toHaveBeenCalled();
});

it("uses only the analysis reader for selection, context, location and annotation preparation", async () => {
  const { facade, bridge, analysis, source } = setup(true);
  bridge.register(analysis);
  expect(facade.getSelection()).toBe(selected);
  expect(facade.getLocation()).toEqual(analysisLocation);
  expect(await facade.getContext()).toBe("# Saved method explanation");
  expect(await facade.prepareAnnotation!(selected)).toBe(selected);
  expect(facade.isNear!(analysisLocation)).toBe(false);
  expect(facade.isNear!(paperLocation)).toBe(false);
  expect(source.getSelection).not.toHaveBeenCalled();
  expect(source.getLocation).not.toHaveBeenCalled();
  expect(source.getContext).not.toHaveBeenCalled();
  expect(source.prepareAnnotation).not.toHaveBeenCalled();
  expect(source.isNear).not.toHaveBeenCalled();
});

it("does not expose hidden paper selection or context while analysis content is loading", async () => {
  const { facade, source } = setup(true);
  expect(facade.getSelection()).toBeNull();
  expect(await facade.getContext()).toBe("");
  expect(source.getSelection).not.toHaveBeenCalled();
  expect(source.getContext).not.toHaveBeenCalled();
});

it("cancels a pending analysis jump when the user navigates back to the paper", async () => {
  const { facade, bridge, analysis, source, visible } = setup();
  const navigation = facade.goTo(analysisLocation);
  const rejected = expect(navigation).rejects.toThrow("定位已取消");
  await facade.goTo(paperLocation);
  await rejected;
  expect(visible()).toBe(false);
  bridge.register(analysis);
  expect(analysis.focusLocation).not.toHaveBeenCalled();
  expect(source.goTo).toHaveBeenCalledExactlyOnceWith(paperLocation);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["cancel", "dispose"] as const)(
  "%s rejects pending navigation and ignores late reader registration",
  async (method) => {
    const { facade, bridge, analysis, source } = setup();
    const navigation = facade.goTo(analysisLocation);
    const rejected = expect(navigation).rejects.toThrow("定位已取消");
    bridge[method]();
    await rejected;
    bridge.register(analysis);
    expect(analysis.focusLocation).not.toHaveBeenCalled();
    expect(source.goTo).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("times out without passing analysis locations to the source engine and permits retry", async () => {
  const { facade, bridge, analysis, source } = setup();
  const navigation = facade.focusReference!(analysisLocation, selected.text);
  const rejected = expect(navigation).rejects.toThrow("尚未加载完成");
  await vi.advanceTimersByTimeAsync(15_000);
  await rejected;
  bridge.register(analysis);
  expect(analysis.focusLocation).not.toHaveBeenCalled();
  expect(source.goTo).not.toHaveBeenCalled();
  expect(source.focusReference).not.toHaveBeenCalled();
  await expect(facade.goTo(analysisLocation)).resolves.toBeUndefined();
  expect(analysis.focusLocation).toHaveBeenCalledExactlyOnceWith(
    analysisLocation,
  );
});

it("supersedes an older pending jump so registration focuses only the latest location", async () => {
  const { facade, bridge, analysis } = setup();
  const first = facade.goTo(analysisLocation);
  const canceled = expect(first).rejects.toThrow("定位已取消");
  const latest = { ...analysisLocation, start: 30, end: 50 };
  const second = facade.goTo(latest);
  await canceled;
  bridge.register(analysis);
  await second;
  expect(analysis.focusLocation).toHaveBeenCalledExactlyOnceWith(latest);
  expect(vi.getTimerCount()).toBe(0);
});

it("propagates a stale analysis version error without pretending a source jump succeeded", async () => {
  const { facade, bridge, analysis, source } = setup();
  analysis.focusLocation.mockRejectedValueOnce(
    new Error("方法解析已更新，此批注属于之前的解析版本"),
  );
  const navigation = facade.focusReference!(analysisLocation, selected.text);
  const rejected = expect(navigation).rejects.toThrow("之前的解析版本");
  bridge.register(analysis);
  await rejected;
  expect(source.goTo).not.toHaveBeenCalled();
  expect(source.focusLocation).not.toHaveBeenCalled();
  expect(source.focusReference).not.toHaveBeenCalled();
  expect(source.search).not.toHaveBeenCalled();
  await expect(facade.goTo(analysisLocation)).resolves.toBeUndefined();
});
