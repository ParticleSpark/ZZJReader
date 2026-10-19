import { useCallback, useEffect, useState } from "react";
import { refreshLibrary, useReaderStore } from "./store";

/** Loading saved documents is independent of AI availability and preferences. */
export function useLibraryLoad() {
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const clearError = useCallback(() => setError(""), []);
  const documents = useReaderStore((state) => state.documents);

  useEffect(() => {
    if (!initialized || loading) return;
    window.readerDesktop?.reportLibraryState?.({
      total: documents.length,
      papers: documents.filter((doc) => doc.library === "papers").length,
      books: documents.filter((doc) => doc.library === "books").length,
      failed: !!error,
    });
  }, [initialized, loading, documents, error]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async (attempt: number) => {
      setLoading(true);
      setError("");
      try {
        await refreshLibrary();
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "无法读取本地书库");
        // Retry transient startup failures, then leave an explicit retry action.
        if (attempt < 2)
          timer = setTimeout(
            () => void load(attempt + 1),
            (attempt + 1) * 1000,
          );
      } finally {
        if (active) {
          setLoading(false);
          setInitialized(true);
        }
      }
    };
    void load(0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [revision]);

  return { loading, initialized, error, retry, clearError };
}
