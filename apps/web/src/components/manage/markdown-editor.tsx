"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { MAX_MARKDOWN_LENGTH } from "@sinnlos/domain";
import { Markdown } from "@/components/markdown";
import { cn } from "@/lib/utils";
import { FieldError, textareaClass } from "./form-controls";

/**
 * The Markdown editor of /manage (UI03, deep-dive decision 06 §L5): a
 * monospace textarea that grows with its text, Write and Preview tabs, and
 * a counter against the 200 000-character limit of the cms (K7
 * MAX_MARKDOWN_LENGTH). The preview is the readers' renderer
 * (components/markdown.tsx: react-markdown with remark-gfm, no
 * rehype-raw), so raw HTML stays text and javascript:/data: links are
 * dropped exactly as on the page. No image upload into bodies (question 8),
 * no new dependency.
 *
 * Tabs follow the ARIA tabs pattern: a tablist, arrow keys move between
 * the tabs (automatic activation), each panel is labelled by its tab, and
 * the textarea keeps its label and description when the preview shows.
 */
export function MarkdownEditor({
  id,
  label,
  hint,
  error,
  value,
  disabled = false,
  defaultTab = "write",
  onChange,
}: {
  /** The textarea's id (fieldInputId). */
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  value: string;
  disabled?: boolean;
  /** The tab shown first (Write). */
  defaultTab?: "write" | "preview";
  onChange: (value: string) => void;
}) {
  const t = useTranslations("manage.common.markdown");
  const [tab, setTab] = useState<"write" | "preview">(defaultTab);
  const writeRef = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLButtonElement>(null);
  const base = useId();
  const writeTabId = `${base}-write-tab`;
  const previewTabId = `${base}-preview-tab`;
  const writePanelId = `${base}-write`;
  const previewPanelId = `${base}-preview`;
  const hintId = `${id}-hint`;
  const counterId = `${id}-counter`;
  const errorId = `${id}-error`;
  const tooLong = value.length > MAX_MARKDOWN_LENGTH;
  // Grows with the text between 8 and 30 lines; longer bodies scroll.
  const rows = Math.min(30, Math.max(8, value.split("\n").length + 1));

  const select = (next: "write" | "preview") => {
    setTab(next);
    (next === "write" ? writeRef : previewRef).current?.focus();
  };
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      select(tab === "write" ? "preview" : "write");
    } else if (event.key === "Home") {
      event.preventDefault();
      select("write");
    } else if (event.key === "End") {
      event.preventDefault();
      select("preview");
    }
  };
  const tabClass = (active: boolean) =>
    cn(
      "rounded-lg px-3 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
      active
        ? "bg-background font-medium shadow-sm"
        : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label htmlFor={id} className="block text-sm font-medium">
          {label}
        </label>
        <div
          role="tablist"
          aria-label={t("mode")}
          className="inline-flex gap-1 rounded-xl border bg-muted/40 p-1"
        >
          <button
            ref={writeRef}
            id={writeTabId}
            type="button"
            role="tab"
            aria-selected={tab === "write"}
            aria-controls={writePanelId}
            tabIndex={tab === "write" ? 0 : -1}
            onClick={() => setTab("write")}
            onKeyDown={onTabKey}
            className={tabClass(tab === "write")}
          >
            {t("write")}
          </button>
          <button
            ref={previewRef}
            id={previewTabId}
            type="button"
            role="tab"
            aria-selected={tab === "preview"}
            aria-controls={previewPanelId}
            tabIndex={tab === "preview" ? 0 : -1}
            onClick={() => setTab("preview")}
            onKeyDown={onTabKey}
            className={tabClass(tab === "preview")}
          >
            {t("preview")}
          </button>
        </div>
      </div>

      <div id={writePanelId} role="tabpanel" aria-labelledby={writeTabId} hidden={tab !== "write"}>
        <textarea
          id={id}
          value={value}
          rows={rows}
          disabled={disabled}
          spellCheck
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={[hint ? hintId : null, counterId, error ? errorId : null]
            .filter(Boolean)
            .join(" ")}
          aria-invalid={error || tooLong ? true : undefined}
          className={textareaClass}
        />
      </div>
      <div
        id={previewPanelId}
        role="tabpanel"
        aria-labelledby={previewTabId}
        hidden={tab !== "preview"}
        tabIndex={0}
        className="min-h-40 rounded-xl border bg-background px-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {value.trim() === "" ? (
          <p className="text-sm text-muted-foreground">{t("emptyPreview")}</p>
        ) : tab === "preview" ? (
          <Markdown className="prose prose-sm prose-slate max-w-none dark:prose-invert">
            {value}
          </Markdown>
        ) : null}
      </div>

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        {hint ? (
          <p id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </p>
        ) : (
          <span />
        )}
        <p
          id={counterId}
          className={cn(
            "text-xs tabular-nums",
            tooLong ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {t("counter", { count: value.length, max: MAX_MARKDOWN_LENGTH })}
        </p>
      </div>
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}
