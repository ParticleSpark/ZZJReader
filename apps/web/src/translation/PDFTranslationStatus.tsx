import type { LibraryMode, Processing } from "@reader/core";

export function PDFTranslationStatus({
  library,
  processing,
}: {
  library?: LibraryMode;
  processing?: Processing;
}) {
  if (!processing) return <p role="status">正在读取正文处理状态。</p>;
  if (processing.status === "failed")
    return (
      <p className="translation-warning" role="alert">
        {processing.phase === "learning" ? "正文解析失败。" : "翻译失败。"}
        {processing.detail && <span>{processing.detail} </span>}
        可在工具栏重试翻译。
      </p>
    );
  if (processing.status === "paused" || processing.enabled === false)
    return (
      <p role="status">
        {processing.startedAt
          ? "翻译已暂停，可在工具栏继续翻译。"
          : "翻译尚未开始，可在工具栏开始翻译。"}
      </p>
    );
  if (processing.status === "waiting")
    return (
      <p role="status">
        {processing.detail || "正在等待 AI 配置，请检查设置中的 AI 连接。"}
      </p>
    );
  if (processing.status === "complete")
    return (
      <p role="status">
        {library === "books"
          ? "尚未翻译任何章节，可在工具栏翻译本章。"
          : "未找到可翻译的正文。"}
      </p>
    );
  return (
    <p role="status">
      {processing.phase === "learning"
        ? processing.status === "queued"
          ? "正在等待解析正文。"
          : "正在解析正文，解析完成后将开始翻译。"
        : "正在加载已解析的正文。"}
    </p>
  );
}
