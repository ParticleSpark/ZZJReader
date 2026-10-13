import type { ReaderTheme } from "@reader/core";
import { api } from "@reader/api";

let saving: Promise<unknown> = Promise.resolve();

/** Keep delayed autosaves ahead of the final window-close save. */
export function saveReaderSettings(theme: ReaderTheme) {
  saving = saving.catch(() => {}).then(() => api.saveSettings(theme));
  return saving;
}
