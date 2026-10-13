import type { Document } from "@reader/core";
import { flushProgress } from "./progress";
import { useReaderStore } from "./store";

let navigation = 0;
/** Save before unmounting; only the latest selection may activate a tab. */
export async function activateReaderTab(
  id: string | null,
  document?: Document,
) {
  const request = ++navigation;
  const revision = useReaderStore.getState().navigationRevision;
  await flushProgress();
  const state = useReaderStore.getState();
  if (request !== navigation || state.navigationRevision !== revision)
    return false;
  if (id === null) {
    state.open(null);
    return true;
  }
  const target =
    state.tabs.find((tab) => tab.id === id) ??
    (document
      ? (state.documents.find((item) => item.id === id) ?? document)
      : undefined);
  if (!target) return false;
  state.open(target);
  return true;
}

export async function closeReaderTab(id: string) {
  if (useReaderStore.getState().active?.id === id) await flushProgress();
  useReaderStore.getState().closeTab(id);
}
