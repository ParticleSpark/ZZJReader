import { useEffect, useState } from "react";
import { api } from "@reader/api";
import { toast } from "sonner";

export type DocumentNoteStatus =
  "loading" | "idle" | "saving" | "saved" | "error";

type NoteState = {
  body: string;
  saved: string;
  loaded: boolean;
  status: DocumentNoteStatus;
  fetching: boolean;
  timer?: ReturnType<typeof setTimeout>;
  writing?: Promise<void>;
  uploads: Set<Promise<unknown>>;
  listeners: Set<() => void>;
};

const notes = new Map<string, NoteState>();

function noteState(id: string) {
  let state = notes.get(id);
  if (!state) {
    state = {
      body: "",
      saved: "",
      loaded: false,
      fetching: false,
      status: "loading",
      uploads: new Set(),
      listeners: new Set(),
    };
    notes.set(id, state);
  }
  return state;
}

function emit(state: NoteState) {
  for (const listener of state.listeners) listener();
}

function persist(id: string): Promise<void> {
  const state = notes.get(id);
  if (!state || !state.loaded) return Promise.resolve();
  if (state.writing) return state.writing;
  if (state.body === state.saved) return Promise.resolve();
  // There is only one writer per document. A flush also waits for edits made
  // while an older request is in flight, so closing cannot drop the newer draft.
  const writing = Promise.resolve().then(async () => {
    try {
      while (notes.get(id) === state && state.body !== state.saved) {
        const text = state.body;
        state.status = "saving";
        emit(state);
        await api.saveDocumentNote(id, text);
        if (notes.get(id) !== state) return;
        state.saved = text;
      }
      state.status = "saved";
    } catch (error) {
      if (notes.get(id) === state) {
        clearTimeout(state.timer);
        state.timer = undefined;
        state.status = "error";
        toast.error(error instanceof Error ? error.message : "笔记未能保存");
      }
      throw error;
    } finally {
      if (notes.get(id) === state) {
        state.writing = undefined;
        emit(state);
      }
    }
  });
  state.writing = writing;
  return writing;
}

function schedule(id: string) {
  const state = notes.get(id);
  if (!state) return;
  clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    // A failed save keeps its draft and waits for an edit or explicit retry.
    void persist(id).catch(() => {});
  }, 800);
}

async function flush(id: string) {
  const state = notes.get(id);
  if (!state) return;
  clearTimeout(state.timer);
  state.timer = undefined;
  while (notes.get(id) === state && state.uploads.size)
    await Promise.all([...state.uploads]);
  if (notes.get(id) === state) await persist(id);
}

/** Wait for all drafts and image insertions before changing libraries or closing. */
export async function flushDocumentNotes() {
  await Promise.all([...notes.keys()].map(flush));
}

/** Call after permanently deleting a document; IDs are reused on reimport. */
export function forgetDocumentNote(id: string) {
  const state = notes.get(id);
  if (state) clearTimeout(state.timer);
  notes.delete(id);
}

/** Drop drafts only after a successful flush or when resetting a test. */
export function clearDocumentNotes() {
  for (const id of notes.keys()) forgetDocumentNote(id);
}

async function load(id: string, state: NoteState) {
  if (state.loaded || state.fetching) return;
  state.fetching = true;
  state.status = "loading";
  emit(state);
  try {
    const note = await api.documentNote(id);
    if (notes.get(id) !== state) return;
    state.body = state.saved = note.body;
    state.loaded = true;
    state.status = "idle";
  } catch (error) {
    if (notes.get(id) !== state) return;
    // Never turn a failed read into an editable empty note: saving that would
    // replace an existing note which the reader has not seen.
    state.status = "error";
    toast.error(error instanceof Error ? error.message : "笔记未能加载");
  } finally {
    if (notes.get(id) === state) {
      state.fetching = false;
      emit(state);
    }
  }
}

function setBody(
  id: string,
  state: NoteState,
  text: string,
  immediate = false,
) {
  if (notes.get(id) !== state || !state.loaded) return;
  state.body = text;
  if (state.status !== "saving") state.status = "idle";
  emit(state);
  if (immediate) void persist(id).catch(() => {});
  else schedule(id);
}

/** The single note for a document. Open editors share one draft and one save. */
export function useDocumentNote(documentId: string) {
  const state = noteState(documentId);
  const [, refresh] = useState(0);
  useEffect(() => {
    const listener = () => refresh((n) => n + 1);
    state.listeners.add(listener);
    void load(documentId, state);
    return () => {
      state.listeners.delete(listener);
      if (state.listeners.size === 0 && state.status !== "error")
        void flush(documentId).catch(() => {});
    };
  }, [documentId, state]);
  return {
    body: state.body,
    loaded: state.loaded,
    status: state.status,
    uploading: state.uploads.size > 0,
    setBody: (text: string, immediate = false) =>
      setBody(documentId, state, text, immediate),
    pasteImages: (files: File[], start: number, end: number) => {
      const base = state.body;
      const upload = Promise.resolve()
        .then(async () => {
          if (!state.loaded || notes.get(documentId) !== state)
            throw new Error("笔记尚未加载");
          const ids: string[] = [];
          for (const file of files) {
            const image = await api.saveNoteImage(documentId, file);
            if (notes.get(documentId) !== state) throw new Error("文档已关闭");
            ids.push(image.id);
          }
          // Another editor, or continued typing here, may have changed the draft.
          // Preserve it verbatim and append instead of overwriting a stale range.
          const unchanged = state.body === base;
          const next = placeNoteImages(
            state.body,
            unchanged ? start : state.body.length,
            unchanged ? end : state.body.length,
            ids,
          );
          setBody(documentId, state, next.text, true);
          return next;
        })
        .finally(() => {
          state.uploads.delete(upload);
          if (notes.get(documentId) === state) emit(state);
        });
      state.uploads.add(upload);
      emit(state);
      return upload;
    },
    retry: () =>
      state.loaded
        ? flush(documentId).catch(() => {})
        : load(documentId, state),
    flush: () => flush(documentId),
  };
}

export function pastedNoteImages(data: DataTransfer | null) {
  if (!data) return [];
  const fromItems = Array.from(data.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (fromItems.length) return fromItems;
  return Array.from(data.files).filter((file) =>
    file.type.startsWith("image/"),
  );
}

export function placeNoteImages(
  body: string,
  start: number,
  end: number,
  ids: string[],
) {
  const snippet = ids.map((id) => `![](note-image:${id})`).join("\n\n");
  const head = body.slice(0, start);
  const tail = body.slice(end);
  const before =
    head && !head.endsWith("\n\n") ? (head.endsWith("\n") ? "\n" : "\n\n") : "";
  const after = tail && !tail.startsWith("\n") ? "\n\n" : "";
  return {
    text: head + before + snippet + after + tail,
    caret: head.length + before.length + snippet.length,
  };
}
