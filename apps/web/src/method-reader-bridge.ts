import { useEffect, useMemo, useRef } from "react";
import type {
  DocumentLocation,
  MethodAnalysisLocation,
  ReaderAdapter,
  ReaderSelection,
} from "@reader/core";
import type { MethodAnalysisReader } from "./method-analysis/MethodAnalysisPage";

/** Routes analysis locations without letting them reach the PDF/EPUB engine. */
export class MethodReaderBridge {
  reader: MethodAnalysisReader | undefined;
  private pending?: {
    location: MethodAnalysisLocation;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };

  constructor(
    private visible: () => boolean,
    private show: (open: boolean) => void,
  ) {}

  register = (reader: MethodAnalysisReader | undefined) => {
    this.reader = reader;
    if (reader && this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      void reader
        .focusLocation(pending.location)
        .then(pending.resolve, pending.reject);
    }
  };

  cancel() {
    if (!this.pending) return;
    clearTimeout(this.pending.timer);
    this.pending.reject(new Error("方法解析定位已取消"));
    this.pending = undefined;
  }

  dispose() {
    this.cancel();
    this.reader = undefined;
  }

  focus(location: MethodAnalysisLocation): Promise<void> {
    this.cancel();
    this.show(true);
    if (this.reader) return this.reader.focusLocation(location);
    // Markdown is lazy-loaded and its stable text index is prepared asynchronously.
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new Error("方法解析尚未加载完成，请稍后重试"));
      }, 15000);
      this.pending = { location, resolve, reject, timer };
    });
  }

  wrap(source: ReaderAdapter): ReaderAdapter {
    const leave = () => {
      this.cancel();
      this.reader?.clearSelection();
      this.show(false);
    };
    const navigate = async (location: DocumentLocation, focus = false) => {
      if (location.type === "method-analysis") return this.focus(location);
      leave();
      if (focus && source.focusLocation) return source.focusLocation(location);
      return source.goTo(location);
    };
    return new Proxy(source, {
      get: (target, key: keyof ReaderAdapter) => {
        if (key === "goTo")
          return (location: DocumentLocation) => navigate(location);
        if (key === "focusLocation")
          return (location: DocumentLocation) => navigate(location, true);
        if (key === "focusReference")
          return async (location: DocumentLocation, text: string) => {
            if (location.type === "method-analysis") {
              await this.focus({ ...location, quote: location.quote ?? text });
              return true;
            }
            leave();
            return (await target.focusReference?.(location, text)) ?? false;
          };
        if (key === "flashReference")
          return (location: DocumentLocation, text: string) => {
            if (location.type !== "method-analysis")
              target.flashReference?.(location, text);
          };
        if (key === "prepareAnnotation")
          return async (selection: ReaderSelection) =>
            selection.location.type === "method-analysis"
              ? selection
              : ((await target.prepareAnnotation?.(selection)) ?? selection);
        if (key === "getSelection")
          return () =>
            this.visible()
              ? (this.reader?.getSelection() ?? null)
              : target.getSelection();
        if (key === "clearSelection")
          return () => {
            this.reader?.clearSelection();
            target.clearSelection();
          };
        if (key === "getLocation")
          return () =>
            (this.visible() ? this.reader?.getLocation() : undefined) ??
            target.getLocation();
        if (key === "getContext")
          return async () =>
            this.visible()
              ? (this.reader?.getContext() ?? "")
              : target.getContext();
        if (key === "isNear")
          return (location: DocumentLocation) =>
            location.type === "method-analysis" || this.visible()
              ? false
              : (target.isNear?.(location) ?? false);
        if (key === "next" || key === "previous")
          return () => {
            leave();
            return target[key]();
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}

export function useMethodReaderBridge(
  documentId: string,
  visible: boolean,
  show: (open: boolean) => void,
) {
  const current = useRef({ visible, show });
  current.current = { visible, show };
  const bridge = useMemo(
    () =>
      new MethodReaderBridge(
        () => current.current.visible,
        (open) => current.current.show(open),
      ),
    [documentId],
  );
  useEffect(() => () => bridge.dispose(), [bridge]);
  useEffect(() => {
    if (!visible) bridge.cancel();
  }, [bridge, visible]);
  return bridge;
}
