import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@reader/api";
import type { MethodAnalysis } from "@reader/core";
import { saveReaderSettings } from "../reader-settings";
import { useReaderStore } from "../store";

export const analysisRunning = (job?: MethodAnalysis) =>
  job?.status === "queued" || job?.status === "running";

/** Viewing a result never starts a task; tasks keep running when this view closes. */
export function useMethodAnalysis(
  documentId: string | undefined,
  enabled: boolean,
) {
  const modelSaving = useReaderStore((store) => store.aiModelSaving);
  const scope = useMemo(
    () => ({ documentId, revision: 0, pending: false }),
    [documentId],
  );
  const current = useRef<typeof scope | undefined>(scope);
  current.current = scope;
  const [state, setState] = useState<{
    documentId?: string;
    job?: MethodAnalysis;
    loading: boolean;
    pending: boolean;
    error: string;
    requestError: string;
  }>({
    documentId,
    loading: false,
    pending: false,
    error: "",
    requestError: "",
  });
  const [reload, setReload] = useState(0);
  const live = () => current.current === scope;
  const update = (patch: Partial<typeof state>) => {
    if (!live()) return;
    setState((previous) => ({
      ...(previous.documentId === documentId
        ? previous
        : {
            documentId,
            loading: false,
            pending: false,
            error: "",
            requestError: "",
          }),
      ...patch,
    }));
  };
  useEffect(() => {
    current.current = scope;
    return () => {
      if (current.current === scope) current.current = undefined;
      scope.revision++;
    };
  }, [scope]);
  useEffect(() => {
    if (!enabled || !documentId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (alive) timer = setTimeout(() => void query(), 1500);
    };
    const query = async () => {
      if (!alive || !live()) return;
      if (scope.pending) return schedule();
      const revision = scope.revision;
      update({ loading: true });
      try {
        const job = await api.methodAnalysis(documentId);
        if (!alive || !live() || revision !== scope.revision) return;
        update({ job, loading: false, requestError: "" });
        if (analysisRunning(job)) schedule();
      } catch (error) {
        if (!alive || !live() || revision !== scope.revision) return;
        update({ loading: false, requestError: (error as Error).message });
        // Keep recovering transient connection failures without ever restarting AI.
        schedule();
      }
    };
    void query();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [scope, enabled, reload]);

  const mutate = async (action: "start" | "cancel", force = false) => {
    if (!documentId || scope.pending || !live()) return;
    if (action === "start" && useReaderStore.getState().aiModelSaving) return;
    scope.pending = true;
    const revision = ++scope.revision;
    update({ pending: true, loading: false, error: "", requestError: "" });
    try {
      if (action === "start") {
        await saveReaderSettings(useReaderStore.getState().theme);
        if (!live() || scope.revision !== revision) return;
        if (useReaderStore.getState().aiModelSaving)
          throw new Error("模型正在保存，请稍后重试");
      }
      const job =
        action === "start"
          ? await api.startMethodAnalysis(documentId, force)
          : await api.cancelMethodAnalysis(documentId);
      if (live() && scope.revision === revision) update({ job });
    } catch (error) {
      if (live() && scope.revision === revision)
        update({ error: (error as Error).message });
    } finally {
      scope.pending = false;
      if (live() && scope.revision === revision) {
        update({ pending: false });
        setReload((value) => value + 1);
      }
    }
  };
  const visible = state.documentId === documentId ? state : undefined;
  return {
    job: visible?.job,
    loading:
      enabled &&
      (visible?.loading ||
        (!visible?.job && !visible?.error && !visible?.requestError)),
    pending: visible?.pending ?? false,
    modelSaving,
    error: visible?.error || visible?.requestError || "",
    start: (force = false) => mutate("start", force),
    cancel: () => mutate("cancel"),
    refresh: () => {
      update({ error: "" });
      setReload((value) => value + 1);
    },
  };
}
