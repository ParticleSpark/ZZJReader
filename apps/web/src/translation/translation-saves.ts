type EditorFlush = () => Promise<void>;

const editors = new Set<EditorFlush>();
const pending = new Set<Promise<void>>();

/** Mounted editors submit their current drafts when the desktop asks to close. */
export function registerTranslationEditor(flush: EditorFlush) {
  editors.add(flush);
  return () => {
    editors.delete(flush);
  };
}

/** A save remains waitable even if its editor unmounts before the request ends. */
export function trackTranslationSave(save: Promise<void>) {
  pending.add(save);
  void save.then(
    () => {
      pending.delete(save);
    },
    () => {
      pending.delete(save);
    },
  );
  return save;
}

export async function flushTranslationEdits() {
  // Capture pending requests first: an editor can unmount during a flush, but
  // its in-flight save must still finish before the backend exits.
  await Promise.all([...pending, ...[...editors].map((flush) => flush())]);
  while (pending.size) await Promise.all([...pending]);
}
