"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, Download, FilePlus, X } from "lucide-react";
import { useCleanDocument } from "@/components/secrets/clean-document";
import { Button } from "@/components/ui/button";
import { downloadBlob } from "@/lib/browser-download";
import { formatBytes } from "@/lib/manage/upload-check";
import {
  PDF_MAX_INPUT_BYTES,
  PDF_MAX_PAGES,
  PDF_MAX_RESULT_BYTES,
  runPdfJob,
  warmUpPdfLibrary,
  type PdfIssue,
  type PdfKind,
  type PdfProgress,
} from "@/lib/pdf-tools";

const MODES: readonly PdfKind[] = ["merge", "split", "rotate", "delete"];
const MB = 1024 * 1024;

interface Entry {
  id: number;
  file: File;
}
interface Result {
  blob: Blob;
  name: string;
  pages: number;
  size: number;
}
type Status =
  | { kind: "idle" }
  | { kind: "working"; progress: PdfProgress | null }
  | { kind: "done"; result: Result }
  | { kind: "failed"; issue: PdfIssue };

/**
 * /tools/pdf (v1.1): merge, pick pages, rotate and delete, in the browser (lib/pdf-tools.ts).
 * Nothing here is sent anywhere: no server action, no request, no storage. The file input and
 * the fields stay locked until the document is known to be free of analytics (useCleanDocument,
 * as on the secrets pages). One job runs at a time; a new job, a change of the list and
 * leaving the page drop the previous result, whose download link exists for one click only
 * (downloadBlob). The order of a merge changes with the buttons next to each file (no drag).
 * Progress and refusals are announced through live regions.
 */
export function PdfTool() {
  const t = useTranslations("tools.pdf");
  const clean = useCleanDocument();
  const ids = useId();
  const [mode, setMode] = useState<PdfKind>("merge");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [ranges, setRanges] = useState("");
  const [turn, setTurn] = useState<90 | -90>(90);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [note, setNote] = useState("");
  const nextId = useRef(1);
  const running = useRef(false);
  const mounted = useRef(true);
  const refocus = useRef<{ id: number; direction: "up" | "down" } | null>(null);
  const busy = status.kind === "working";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A moved item is a different DOM position: keep the keyboard where it was (or on the
  // other arrow when the item reached an end and its button turned off).
  useEffect(() => {
    const target = refocus.current;
    refocus.current = null;
    if (!target) return;
    const button = (direction: string) =>
      document.getElementById(`${ids}-${target.id}-${direction}`) as HTMLButtonElement | null;
    const same = button(target.direction);
    (same && !same.disabled ? same : button(target.direction === "up" ? "down" : "up"))?.focus();
  }, [entries, ids]);

  const choose = (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    if (picked.length === 0) return;
    warmUpPdfLibrary();
    const added = picked.map((file) => ({ id: nextId.current++, file }));
    setStatus({ kind: "idle" });
    setNote("");
    setEntries((current) => (mode === "merge" ? [...current, ...added] : added.slice(0, 1)));
  };

  const move = (index: number, delta: -1 | 1) => {
    const entry = entries[index]!;
    const next = [...entries];
    next.splice(index, 1);
    next.splice(index + delta, 0, entry);
    refocus.current = { id: entry.id, direction: delta === -1 ? "up" : "down" };
    setStatus({ kind: "idle" });
    setNote(
      t("moved", { name: entry.file.name, position: index + delta + 1, total: entries.length }),
    );
    setEntries(next);
  };

  const remove = (index: number) => {
    setStatus({ kind: "idle" });
    setNote(t("removed", { name: entries[index]!.file.name }));
    setEntries(entries.filter((_, i) => i !== index));
  };

  const run = async () => {
    if (running.current) return;
    running.current = true;
    setNote("");
    // The previous result is dropped here, before the next job reads anything.
    setStatus({ kind: "working", progress: null });
    try {
      const outcome = await runPdfJob(
        { kind: mode, files: entries.map((entry) => entry.file), ranges, turn },
        (progress) => {
          if (mounted.current) setStatus({ kind: "working", progress });
        },
      );
      if (!mounted.current) return;
      setStatus(
        outcome.ok
          ? {
              kind: "done",
              result: {
                blob: new Blob([outcome.bytes], { type: "application/pdf" }),
                name: t(`fileNames.${mode}`),
                pages: outcome.pages,
                size: outcome.bytes.length,
              },
            }
          : { kind: "failed", issue: outcome.issue },
      );
    } finally {
      running.current = false;
    }
  };

  const issueText = (issue: PdfIssue): string => {
    switch (issue.code) {
      case "ranges":
        return t(`rangeErrors.${issue.issue.code}`, {
          part: "part" in issue.issue ? issue.issue.part : "",
          pageCount: "pageCount" in issue.issue ? issue.issue.pageCount : 0,
          max: "max" in issue.issue ? issue.issue.max : 0,
        });
      case "encrypted":
      case "broken":
        return t(`errors.${issue.code}`, { name: issue.name });
      default:
        return t(`errors.${issue.code}`, {
          size: Math.round(
            (issue.code === "resultTooBig" ? PDF_MAX_RESULT_BYTES : PDF_MAX_INPUT_BYTES) / MB,
          ),
          pages: PDF_MAX_PAGES,
        });
    }
  };

  const progressText = (progress: PdfProgress | null): string =>
    progress?.stage === "file"
      ? t("progressFile", {
          index: progress.index + 1,
          total: progress.total,
          name: progress.name,
        })
      : progress?.stage === "saving"
        ? t("progressSaving")
        : "";

  const totalBytes = entries.reduce((sum, entry) => sum + entry.file.size, 0);

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-2 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{t("privacy")}</p>
        <p>{t("notice")}</p>
        <p>
          {t("limits", {
            size: Math.round(PDF_MAX_INPUT_BYTES / MB),
            pages: PDF_MAX_PAGES,
          })}
        </p>
      </div>

      <fieldset disabled={busy || !clean} className="min-w-0 space-y-6">
        <fieldset>
          <legend className="mb-1 block text-sm font-medium">{t("mode")}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {MODES.map((value) => (
              <label key={value} className="inline-flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${ids}-mode`}
                  value={value}
                  checked={mode === value}
                  onChange={() => {
                    setMode(value);
                    setStatus({ kind: "idle" });
                  }}
                />
                {t(`modes.${value}`)}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t(`modeHints.${mode}`)}</p>
        </fieldset>

        <div>
          <label htmlFor={`${ids}-files`} className="mb-1 block text-sm font-medium">
            {t("files")}
          </label>
          <input
            id={`${ids}-files`}
            type="file"
            accept=".pdf,application/pdf"
            multiple={mode === "merge"}
            aria-describedby={`${ids}-files-hint`}
            onChange={(event) => {
              const input = event.currentTarget;
              choose(input.files);
              // The same file can be chosen again.
              input.value = "";
            }}
            className="block w-full text-sm file:mr-3 file:h-9 file:rounded-xl file:border file:bg-background file:px-3 file:text-sm file:font-medium hover:file:bg-accent"
          />
          <p id={`${ids}-files-hint`} className="mt-1 text-xs text-muted-foreground">
            {t(mode === "merge" ? "filesHintMany" : "filesHintOne")}
          </p>
        </div>

        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="space-y-2">
            <ol aria-label={t("listLabel")} className="space-y-2">
              {entries.map((entry, index) => (
                <li
                  key={entry.id}
                  className="flex items-center gap-2 rounded-xl border bg-muted/40 py-1.5 pl-3 pr-1.5"
                >
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {entry.file.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatBytes(entry.file.size)}
                  </span>
                  {mode === "merge" && (
                    <>
                      <Button
                        id={`${ids}-${entry.id}-up`}
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={index === 0}
                        aria-label={t("moveUp", { name: entry.file.name })}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        id={`${ids}-${entry.id}-down`}
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={index === entries.length - 1}
                        aria-label={t("moveDown", { name: entry.file.name })}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("remove", { name: entry.file.name })}
                    onClick={() => remove(index)}
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ol>
            <p className="text-xs text-muted-foreground">
              {t("total", { count: entries.length, size: formatBytes(totalBytes) })}
            </p>
          </div>
        )}

        {mode !== "merge" && (
          <div>
            <label htmlFor={`${ids}-ranges`} className="mb-1 block text-sm font-medium">
              {t("ranges")}
            </label>
            <input
              id={`${ids}-ranges`}
              type="text"
              value={ranges}
              onChange={(event) => setRanges(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-describedby={`${ids}-ranges-hint`}
              className="h-10 w-full rounded-xl border bg-muted/40 px-3 text-sm outline-hidden focus:bg-background focus:ring-2 focus:ring-ring"
            />
            <p id={`${ids}-ranges-hint`} className="mt-1 text-xs text-muted-foreground">
              {t(`rangesHints.${mode}`)}
            </p>
          </div>
        )}

        {mode === "rotate" && (
          <fieldset>
            <legend className="mb-1 block text-sm font-medium">{t("turn")}</legend>
            <div className="flex flex-wrap gap-4">
              {([90, -90] as const).map((value) => (
                <label key={value} className="inline-flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`${ids}-turn`}
                    checked={turn === value}
                    onChange={() => setTurn(value)}
                  />
                  {t(value === 90 ? "turnRight" : "turnLeft")}
                </label>
              ))}
            </div>
          </fieldset>
        )}
      </fieldset>

      {/* Outside the locked fieldset and only aria-disabled while a job runs, so the keyboard keeps its place. */}
      <Button
        type="button"
        disabled={!clean || entries.length === 0}
        aria-disabled={busy}
        className="aria-disabled:opacity-50"
        onClick={() => void run()}
      >
        <FilePlus className="h-4 w-4" aria-hidden="true" />
        {t("run")}
      </Button>

      {/* Live regions: the list's changes, the progress and result, and the refusals. */}
      <p role="status" className="sr-only">
        {note}
      </p>
      <p role="status" className="text-sm text-muted-foreground">
        {status.kind === "working" ? progressText(status.progress) : null}
        {status.kind === "done"
          ? t("done", { pages: status.result.pages, size: formatBytes(status.result.size) })
          : null}
      </p>
      {status.kind === "failed" ? (
        <p role="alert" className="text-sm text-destructive">
          {issueText(status.issue)}
        </p>
      ) : null}
      {status.kind === "done" ? (
        <Button type="button" onClick={() => downloadBlob(status.result.blob, status.result.name)}>
          <Download className="h-4 w-4" aria-hidden="true" />
          {t("download", { name: status.result.name })}
        </Button>
      ) : null}
    </div>
  );
}
