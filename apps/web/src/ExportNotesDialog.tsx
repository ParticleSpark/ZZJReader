import { useState } from "react";
import { Copy, Download } from "lucide-react";
import type { Annotation, Document, Message } from "@reader/core";
import { Button } from "@reader/ui/components/button";
import { Checkbox } from "@reader/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@reader/ui/components/dialog";
import { copyText } from "./chat/clipboard";
import {
  defaultExportParts,
  exportCounts,
  exportParts,
  notesMarkdown,
  type ExportPart,
} from "./notes-export";
import { downloadText } from "./download";
import { useDocumentNote } from "./document-note";

const storageKey = "reader.notes-export";
function savedParts(): ExportPart[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) || "");
    if (Array.isArray(value))
      return value.filter((part): part is ExportPart => part in exportParts);
  } catch {
    /* fall back to defaults */
  }
  return defaultExportParts;
}

export function ExportNotesDialog({
  document: doc,
  annotations,
  messages,
  link,
  onClose,
}: {
  document: Document;
  annotations: Annotation[];
  messages: Message[];
  link?: (annotation: Annotation) => string;
  onClose: () => void;
}) {
  const [parts, setParts] = useState<ExportPart[]>(savedParts);
  const note = useDocumentNote(doc.id);
  const data = { annotations, messages, paperNote: note.body };
  const includesImages =
    parts.includes("paperNote") &&
    /!\[[^\]]*\]\(note-image:[0-9a-f]{32}\.(?:png|jpe?g|gif|webp)\)/.test(
      note.body,
    );
  const counts = exportCounts(data);
  const toggle = (part: ExportPart, on: boolean) => {
    const next = on ? [...parts, part] : parts.filter((item) => item !== part);
    setParts(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* the choice only lasts for this dialog */
    }
  };
  const markdown = () => notesMarkdown(doc, data, parts, link);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>导出批注与笔记</DialogTitle>
          <DialogDescription>
            Markdown，可放进 Obsidian 或 Notion
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2.5">
          {(Object.keys(exportParts) as ExportPart[])
            .filter((part) => doc.library === "papers" || part !== "info")
            .map((part) => (
              <label key={part} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={parts.includes(part)}
                  disabled={part !== "info" && !counts[part]}
                  onCheckedChange={(checked) => toggle(part, !!checked)}
                />
                <span className="flex-1">{exportParts[part]}</span>
                {part !== "info" && (
                  <span className="text-xs text-muted-foreground">
                    {counts[part]}
                  </span>
                )}
              </label>
            ))}
        </div>
        {includesImages && (
          <p className="text-sm text-muted-foreground">
            粘贴的图片仅在 Reader 内显示，Markdown 导出不包含图片文件
          </p>
        )}
        {!note.loaded && note.status === "error" && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>笔记未能加载</span>
            <Button size="xs" variant="ghost" onClick={() => void note.retry()}>
              重试
            </Button>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            disabled={!note.loaded || note.uploading}
            onClick={() => void copyText(markdown(), "已复制 Markdown")}
          >
            <Copy />
            复制
          </Button>
          <Button
            disabled={!note.loaded || note.uploading}
            onClick={() => {
              downloadText(
                markdown(),
                `${doc.title.replace(/[/\\:*?"<>|]/g, "-").slice(0, 80)}-notes.md`,
                "text/markdown",
              );
              onClose();
            }}
          >
            <Download />
            导出
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
