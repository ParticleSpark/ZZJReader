import type {
  Annotation,
  MethodAnalysisLocation,
  ReaderEvents,
  ReaderSelection,
} from "@reader/core";
import {
  isSelectionToolbar,
  selectionAnchor,
} from "../readers/selection-anchor";
import {
  indexMethodText,
  methodAnalysisContentHash,
  methodLocationRanges,
  methodSelectionOffsets,
  type MethodTextIndex,
} from "./method-analysis-text";

export interface MethodAnalysisReader {
  getSelection(): ReaderSelection | null;
  clearSelection(): void;
  focusLocation(location: MethodAnalysisLocation): Promise<void>;
  getContext(): string;
  getLocation(): MethodAnalysisLocation | undefined;
}
export type MethodAnalysisEvents = Pick<
  ReaderEvents,
  "selection" | "annotation"
>;

const interactive = "a,button,input,textarea,select,.code-toolbar";
let sequence = 0;
const containsPoint = (range: Range, x: number, y: number) =>
  Array.from(range.getClientRects()).some(
    (r) =>
      r.width > 0 &&
      r.height > 0 &&
      x >= r.left &&
      x <= r.right &&
      y >= r.top &&
      y <= r.bottom,
  );

/** Owns only the saved analysis article; never observes or annotates its draft. */
export class SavedMethodAnalysisReader implements MethodAnalysisReader {
  readonly ready: Promise<void>;
  private contentHash = "";
  private error: Error | undefined;
  private disposed = false;
  private selected: ReaderSelection | null = null;
  private focused: MethodAnalysisLocation | undefined;
  private annotations: Annotation[] = [];
  private names: string[] = [];
  private marks: Array<{ id: string; range: Range }> = [];
  private prefix = `reader-method-${++sequence}`;
  private style = document.createElement("style");
  private observer: MutationObserver | undefined;
  private dragging = false;
  private toolbar = false;
  private pointer: { x: number; y: number } | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private index: MethodTextIndex = { text: "", nodes: [] };
  private viewport: HTMLElement;

  constructor(
    private host: HTMLElement,
    private content: string,
    private events: MethodAnalysisEvents,
  ) {
    this.index = indexMethodText(host);
    this.viewport = host.closest<HTMLElement>(".method-analysis-page") ?? host;
    document.head.append(this.style);
    document.addEventListener("pointerdown", this.press, true);
    document.addEventListener("pointerup", this.release, true);
    document.addEventListener("pointercancel", this.release, true);
    document.addEventListener("selectionchange", this.selectionChanged);
    document.addEventListener("focusin", this.focusChanged);
    host.addEventListener("keyup", this.selectionChanged);
    host.addEventListener("keydown", this.keydown);
    host.addEventListener("click", this.click);
    this.viewport.addEventListener("scroll", this.scrolled, true);
    window.addEventListener("resize", this.scrolled);
    this.observer = new MutationObserver(() => {
      if (this.disposed) return;
      this.index = indexMethodText(host);
      this.paint();
      // Lazy math/code rendering can replace text nodes without changing the
      // Markdown. Re-read the actual selection and verify every saved quote.
      if (!this.toolbar) this.capture();
    });
    this.observer.observe(host, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    this.ready = content.trim()
      ? methodAnalysisContentHash(content).then(
          (hash) => {
            if (this.disposed) return;
            this.contentHash = hash;
            this.paint();
            this.capture();
          },
          () => {
            this.error = new Error("无法准备方法解析批注，请重新打开此页面");
          },
        )
      : Promise.resolve();
  }

  update(annotations: Annotation[], events: MethodAnalysisEvents) {
    this.events = events;
    this.annotations = annotations;
    this.paint();
  }

  getContext() {
    return this.content;
  }

  getSelection() {
    return this.disposed ? null : this.selected;
  }

  getLocation() {
    if (this.disposed || !this.contentHash) return;
    if (this.selected?.location.type === "method-analysis")
      return this.selected.location;
    if (this.focused) return this.focused;
    if (!this.index.text) return;
    const end = Math.min(this.index.text.length, 160);
    return {
      type: "method-analysis" as const,
      contentHash: this.contentHash,
      start: 0,
      end,
      quote: this.index.text.slice(0, end),
    };
  }

  clearSelection() {
    const native = window.getSelection();
    if (
      native &&
      (this.host.contains(native.anchorNode) ||
        this.host.contains(native.focusNode))
    )
      native.removeAllRanges();
    this.selected = null;
    this.events.selection(null);
  }

  async focusLocation(location: MethodAnalysisLocation) {
    await this.ready;
    if (this.disposed) throw new Error("方法解析页面已关闭");
    if (this.error) throw this.error;
    if (!this.contentHash) throw new Error("当前没有已保存的方法解析");
    if (location.contentHash !== this.contentHash)
      throw new Error("方法解析已更新，此批注属于之前的解析版本");
    this.index = indexMethodText(this.host);
    const ranges = methodLocationRanges(this.index, this.contentHash, location);
    if (!ranges.length) throw new Error("当前方法解析中无法准确定位此批注");
    this.focused = location;
    this.clearSelection();
    const viewport = this.host.closest<HTMLElement>(".method-analysis-page");
    const rect = ranges[0].getBoundingClientRect();
    if (viewport) {
      const view = viewport.getBoundingClientRect();
      viewport.scrollTop += rect.top - view.top - view.height * 0.35;
    } else {
      ranges[0].startContainer.parentElement?.scrollIntoView?.({
        block: "center",
      });
    }
    if (typeof Highlight !== "undefined" && globalThis.CSS?.highlights) {
      const mark = new Highlight(...ranges);
      mark.priority = 2;
      CSS.highlights.set(`${this.prefix}-focus`, mark);
      clearTimeout(this.flashTimer);
      this.flashTimer = setTimeout(() => {
        CSS.highlights.delete(`${this.prefix}-focus`);
      }, 1800);
    }
  }

  private capture = () => {
    if (this.disposed || !this.contentHash || this.toolbar || this.dragging)
      return;
    const native = window.getSelection();
    if (
      !native?.rangeCount ||
      native.isCollapsed ||
      !this.host.contains(native.anchorNode) ||
      !this.host.contains(native.focusNode)
    ) {
      if (this.selected) {
        this.selected = null;
        this.events.selection(null);
      }
      return;
    }
    const offsets = methodSelectionOffsets(this.index, native.getRangeAt(0));
    if (!offsets) return;
    const value: ReaderSelection = {
      text: offsets.quote,
      location: {
        type: "method-analysis",
        contentHash: this.contentHash,
        ...offsets,
      },
      anchor: selectionAnchor(native, this.pointer),
    };
    this.selected = value;
    this.events.annotation?.(null);
    this.events.selection(value);
  };
  private selectionChanged = () => this.capture();
  private focusChanged = (event: FocusEvent) => {
    if (isSelectionToolbar(event.target)) this.toolbar = true;
    else if (this.host.contains(event.target as Node)) this.toolbar = false;
  };
  private press = (event: PointerEvent) => {
    if (isSelectionToolbar(event.target)) {
      this.toolbar = true;
      return;
    }
    this.toolbar = false;
    this.events.annotation?.(null);
    this.pointer = { x: event.clientX, y: event.clientY };
    this.dragging = this.host.contains(event.target as Node);
    if (!this.dragging && this.selected) {
      this.selected = null;
      this.events.selection(null);
    }
  };
  private release = (event: PointerEvent) => {
    if (this.toolbar || isSelectionToolbar(event.target)) return;
    this.dragging = false;
    this.pointer = { x: event.clientX, y: event.clientY };
    this.capture();
  };
  private scrolled = () => {
    this.toolbar = false;
    if (this.selected) this.clearSelection();
    this.events.annotation?.(null);
  };
  private keydown = (event: KeyboardEvent) => {
    this.toolbar = false;
    this.pointer = undefined;
    if (
      event.key.toLowerCase() !== "a" ||
      !(event.ctrlKey || event.metaKey) ||
      (event.target instanceof Element && event.target.closest(interactive))
    )
      return;
    event.preventDefault();
    const range = document.createRange();
    range.selectNodeContents(this.host);
    const native = window.getSelection();
    native?.removeAllRanges();
    native?.addRange(range);
    this.capture();
  };
  private click = (event: MouseEvent) => {
    if (
      this.selected ||
      (event.target instanceof Element && event.target.closest(interactive))
    )
      return;
    const hits = this.marks.filter(({ range }) =>
      containsPoint(range, event.clientX, event.clientY),
    );
    this.events.annotation?.(
      hits.length
        ? {
            ids: [...new Set(hits.map(({ id }) => id))],
            anchor: {
              x: event.clientX,
              top: event.clientY - 8,
              bottom: event.clientY + 8,
            },
          }
        : null,
    );
  };

  private paint() {
    if (this.disposed) return;
    const registry = globalThis.CSS?.highlights;
    for (const name of this.names) registry?.delete(name);
    this.names = [];
    this.marks = [];
    const groups = new Map<string, Range[]>();
    const rules = [
      `::highlight(${this.prefix}-focus) { background-color: color-mix(in srgb, var(--primary) 28%, transparent); }`,
    ];
    for (const annotation of this.annotations) {
      if (
        annotation.location.type !== "method-analysis" ||
        annotation.kind === "bookmark"
      )
        continue;
      const ranges = methodLocationRanges(
        this.index,
        this.contentHash,
        annotation.location,
        annotation.location.quote || annotation.quote,
      );
      if (!ranges.length) continue;
      this.marks.push(...ranges.map((range) => ({ id: annotation.id, range })));
      const color = /^#[\da-f]{6}$/i.test(annotation.color)
        ? annotation.color
        : "#e6b94c";
      const underline = annotation.kind === "underline";
      const name = `${this.prefix}-${underline ? "line" : "mark"}-${color.slice(1)}`;
      if (!groups.has(name)) {
        groups.set(name, []);
        rules.push(
          `::highlight(${name}) { ${underline ? `text-decoration: underline 2px ${color};` : `background-color: ${color}66;`} }`,
        );
      }
      groups.get(name)!.push(...ranges);
    }
    this.style.textContent = rules.join("\n");
    if (typeof Highlight === "undefined" || !registry) return;
    for (const [name, ranges] of groups) {
      const highlight = new Highlight(...ranges);
      highlight.priority = 1;
      registry.set(name, highlight);
      this.names.push(name);
    }
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    document.removeEventListener("pointerdown", this.press, true);
    document.removeEventListener("pointerup", this.release, true);
    document.removeEventListener("pointercancel", this.release, true);
    document.removeEventListener("selectionchange", this.selectionChanged);
    document.removeEventListener("focusin", this.focusChanged);
    this.host.removeEventListener("keyup", this.selectionChanged);
    this.host.removeEventListener("keydown", this.keydown);
    this.host.removeEventListener("click", this.click);
    this.viewport.removeEventListener("scroll", this.scrolled, true);
    window.removeEventListener("resize", this.scrolled);
    this.clearSelection();
    this.events.annotation?.(null);
    clearTimeout(this.flashTimer);
    for (const name of [...this.names, `${this.prefix}-focus`])
      globalThis.CSS?.highlights?.delete(name);
    this.style.remove();
  }
}
