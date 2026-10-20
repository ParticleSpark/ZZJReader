import { lazy, Suspense, useEffect, useRef } from "react";
import type { Annotation } from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { LoaderCircle, ScanText } from "lucide-react";
import { analysisRunning, type useMethodAnalysis } from "./useMethodAnalysis";
import {
  SavedMethodAnalysisReader,
  type MethodAnalysisEvents,
  type MethodAnalysisReader,
} from "./MethodAnalysisReader";
import "./method-analysis.css";

export type { MethodAnalysisReader } from "./MethodAnalysisReader";

const MessageMarkdown = lazy(() =>
  import("../chat/MessageMarkdown").then((module) => ({
    default: module.MessageMarkdown,
  })),
);

export type MethodAnalysisController = ReturnType<typeof useMethodAnalysis>;
const noEvents: MethodAnalysisEvents = { selection: () => {} };
const noAnnotations: Annotation[] = [];

function SavedAnalysisContent({
  content,
  documentId,
  annotations,
  events,
  onReady,
}: {
  content: string;
  documentId: string;
  annotations: Annotation[];
  events: MethodAnalysisEvents;
  onReady?: (controller: MethodAnalysisReader | undefined) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const reader = useRef<SavedMethodAnalysisReader | undefined>(undefined);
  const latest = useRef({ annotations, events, onReady });
  latest.current = { annotations, events, onReady };
  useEffect(() => {
    if (!host.current) return;
    const instance = new SavedMethodAnalysisReader(
      host.current,
      content,
      latest.current.events,
    );
    reader.current = instance;
    instance.update(
      latest.current.annotations.filter(
        (item) => item.documentId === documentId,
      ),
      latest.current.events,
    );
    let active = true;
    void instance.ready.then(() => {
      if (active) latest.current.onReady?.(instance);
    });
    return () => {
      active = false;
      reader.current = undefined;
      instance.destroy();
      latest.current.onReady?.(undefined);
    };
  }, [documentId, content]);
  useEffect(() => {
    reader.current?.update(
      annotations.filter((item) => item.documentId === documentId),
      events,
    );
  }, [annotations, events, documentId]);
  return (
    <div ref={host} className="method-analysis-body" tabIndex={0}>
      <MessageMarkdown
        content={content}
        animated={false}
        documentId={documentId}
      />
    </div>
  );
}

export function MethodAnalysisButton({
  analysis,
  onOpen,
}: {
  analysis: MethodAnalysisController;
  onOpen: () => void;
}) {
  const { job, pending, loading, error, modelSaving } = analysis;
  const running = analysisRunning(job);
  const complete = job?.status === "complete";
  const waiting = loading && !job;
  const readFailed = !!error && !job;
  const label = waiting
    ? "正在读取…"
    : pending
      ? "正在处理…"
      : job?.status === "queued"
        ? "等待解析…"
        : running
          ? "正在解析…"
          : complete
            ? "解析完成"
            : readFailed
              ? "重试读取"
              : job?.status === "failed"
                ? "重试解析"
                : "开始解析";
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending || modelSaving || waiting || running || complete}
      title={
        complete
          ? "解析已完成，可在“方法解析”中查看结果"
          : "使用 AI 助读模型解析整篇论文的方法"
      }
      onClick={() => {
        onOpen();
        if (readFailed) analysis.refresh();
        else void analysis.start();
      }}
    >
      {waiting || pending || running ? (
        <LoaderCircle className="method-analysis-spinner" />
      ) : (
        <ScanText />
      )}
      {label}
    </Button>
  );
}

export function MethodAnalysisPage({
  documentId,
  analysis,
  annotations = noAnnotations,
  events = noEvents,
  onReady,
}: {
  documentId: string;
  analysis: MethodAnalysisController;
  annotations?: Annotation[];
  events?: MethodAnalysisEvents;
  onReady?: (controller: MethodAnalysisReader | undefined) => void;
}) {
  const { job, pending, error, loading } = analysis;
  const running = analysisRunning(job);
  const hasContent = !!job?.content.trim();
  const waitingForResult = loading && !job;
  useEffect(() => {
    if (hasContent || waitingForResult) return;
    const empty: MethodAnalysisReader = {
      getSelection: () => null,
      clearSelection: () => events.selection(null),
      focusLocation: async () => {
        throw new Error("当前没有已保存的方法解析");
      },
      getContext: () => "",
      getLocation: () => undefined,
    };
    onReady?.(empty);
    return () => onReady?.(undefined);
  }, [hasContent, waitingForResult, documentId, onReady, events]);
  const status =
    pending && !running
      ? "正在开始方法解析…"
      : error && !job
        ? "方法解析暂时无法读取"
        : loading && !job
          ? "正在读取方法解析…"
          : job?.status === "queued"
            ? job.detail || "等待方法解析…"
            : job?.status === "running"
              ? job.detail || "正在解析论文方法…"
              : job?.status === "failed"
                ? "方法解析失败"
                : job?.status === "canceled"
                  ? "方法解析已取消"
                  : hasContent
                    ? "解析完成"
                    : "还没有方法解析";
  const startLabel = hasContent
    ? "重新解析"
    : job?.status === "failed"
      ? "重试解析"
      : "开始解析";
  return (
    <section className="method-analysis-page" aria-label="论文方法解析">
      <div className="method-analysis-content">
        <header className="method-analysis-header">
          <div>
            <h2>方法解析</h2>
            <p role="status" className="method-analysis-status">
              {(running || (loading && !job)) && (
                <LoaderCircle className="method-analysis-spinner" />
              )}
              {status}
            </p>
          </div>
          {running ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void analysis.cancel()}
            >
              {pending ? "正在取消…" : "取消解析"}
            </Button>
          ) : (
            <Button
              size="sm"
              variant={hasContent ? "outline" : "default"}
              disabled={pending || analysis.modelSaving || (loading && !job)}
              onClick={() => void analysis.start(hasContent)}
            >
              {pending ? "正在开始…" : startLabel}
            </Button>
          )}
        </header>
        {(error || job?.error) && (
          <div role="alert" className="method-analysis-error">
            <span>{error || job?.error}</span>
            {error && (
              <Button size="xs" variant="ghost" onClick={analysis.refresh}>
                重新加载
              </Button>
            )}
          </div>
        )}
        {!hasContent && !running && !job?.draft && !loading && (
          <p className="method-analysis-empty">
            使用 AI 助读模型，结合论文全文解析主要方法、关键步骤与适用条件。
          </p>
        )}
        {hasContent && (
          <article aria-label="已保存的方法解析">
            {(running ||
              job?.status === "failed" ||
              job?.status === "canceled") && (
              <p className="method-analysis-label">上次完成的解析</p>
            )}
            <Suspense fallback={<p>正在显示解析…</p>}>
              <SavedAnalysisContent
                content={job!.content}
                documentId={documentId}
                annotations={annotations}
                events={events}
                onReady={onReady}
              />
            </Suspense>
          </article>
        )}
        {job?.draft && job.status !== "complete" && (
          <article
            className="method-analysis-draft"
            aria-label="尚未完成的方法解析"
          >
            <p className="method-analysis-label">
              {running ? "本次解析 · 生成中" : "本次解析 · 未完成"}
              {" · 解析完成后可添加批注"}
            </p>
            <Suspense fallback={<p>正在显示解析…</p>}>
              <MessageMarkdown
                content={job.draft}
                generating={running}
                animated={false}
                documentId={documentId}
              />
            </Suspense>
          </article>
        )}
      </div>
    </section>
  );
}
