import { flushProgress } from "./progress";
import { flushDocumentNotes } from "./document-note";
import { saveReaderSettings } from "./reader-settings";
import { flushTranslationEdits } from "./translation/translation-saves";
import { useReaderStore } from "./store";

/** Save reading state when the window closes. Installed outside React so a crashed UI still answers the desktop close request. */
export function installCloseFlush() {
  const flush = () => {
    void flushProgress().catch(() => {});
    void flushDocumentNotes().catch(() => {});
    void flushTranslationEdits().catch(() => {});
  };
  window.addEventListener("pagehide", flush);
  const removeClose = window.readerDesktop?.onBeforeClose(async () => {
    await Promise.all([
      flushProgress(),
      flushDocumentNotes(),
      flushTranslationEdits(),
    ]);
    await saveReaderSettings(useReaderStore.getState().theme);
  });
  return () => {
    window.removeEventListener("pagehide", flush);
    removeClose?.();
  };
}
