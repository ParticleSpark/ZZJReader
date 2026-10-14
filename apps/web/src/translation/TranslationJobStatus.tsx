import type { Processing } from "@reader/core";
import { Button } from "@reader/ui/components/button";

export function translationJobStatus(processing?: Processing) {
  if (processing?.enabled === false || processing?.status === "paused")
    return "paused";
  if (processing?.status === "failed" || processing?.status === "waiting")
    return processing.status;
  return processing?.translating?.status ?? processing?.status;
}

/** Explain a blocked job once, while each unfinished paragraph stays compact. */
export function TranslationJobStatus({
  processing,
  retry,
}: {
  processing?: Processing;
  retry?: () => void;
}) {
  const status = translationJobStatus(processing);
  if (status !== "waiting" && status !== "failed") return null;
  const detail =
    status === processing?.translating?.status
      ? processing.translating.detail || processing.detail
      : processing?.detail;
  return (
    <div
      className="translation-warning"
      role={status === "failed" ? "alert" : "status"}
    >
      {status === "waiting" ? "翻译等待 AI 配置。" : "翻译已停止。"}
      {detail && <span>{detail} </span>}
      {status === "waiting"
        ? "请检查设置中的 AI 连接和能力测试。"
        : "可在工具栏重试翻译。"}
      {status === "failed" && retry && (
        <Button size="sm" variant="ghost" onClick={retry}>
          重试翻译
        </Button>
      )}
    </div>
  );
}
