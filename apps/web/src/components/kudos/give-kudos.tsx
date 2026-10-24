"use client";

import { useId, useMemo, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Award, Check, Send, X, Search } from "lucide-react";
import { ModalDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { isSharedErrorCode, startCmsAction, type CommonCode } from "@/lib/action-result";
import { sendKudos } from "@/lib/kudos-actions";
import type { KudosRecipient } from "@/lib/people-dto";
import type { KudosValue } from "@/lib/types";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initials } from "@/lib/utils";

const VALUES: {
  value: KudosValue;
  labelKey: "teamwork" | "innovation" | "leadership" | "customerFocus" | "excellence";
  emoji: string;
}[] = [
  { value: "teamwork", labelKey: "teamwork", emoji: "\u{1F91D}" },
  { value: "innovation", labelKey: "innovation", emoji: "\u{1F4A1}" },
  { value: "leadership", labelKey: "leadership", emoji: "\u{1F31F}" },
  { value: "customer-focus", labelKey: "customerFocus", emoji: "\u{1F3AF}" },
  { value: "excellence", labelKey: "excellence", emoji: "\u{1F3C6}" },
];

/**
 * `people` is the lean picker DTO (lib/people-dto.ts, WD05): name, job
 * title and avatar thumbnail of every other active colleague — the page
 * sends nothing else to the browser.
 *
 * The dialog is the shared ModalDialog (UI07, Radix Dialog): focus trap,
 * Escape and backdrop close, focus back on the "Give kudos" button. The
 * search input takes the first focus (autoFocus) when no recipient is
 * picked. Closing keeps what was typed; a sent kudos clears and closes.
 *
 * Accessibility (S6): the search input and the message are labelled; the
 * suggestions are plain buttons with a polite result count; picking one
 * moves focus to the message (the picked button disappears). The values
 * are native radios in a fieldset, so arrow keys work; the picked one also
 * carries a check mark.
 */
export function GiveKudos({ people }: { people: KudosRecipient[] }) {
  const t = useTranslations("kudos");
  const tErrors = useTranslations("actionErrors");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<KudosRecipient | null>(null);
  const [message, setMessage] = useState("");
  const [value, setValue] = useState<KudosValue>("teamwork");
  const [error, setError] = useState<CommonCode | null>(null);
  const [isPending, startTransition] = useTransition();
  const searchId = useId();
  const messageId = useId();
  const messageRef = useRef<HTMLTextAreaElement>(null);

  const filtered = useMemo(() => {
    if (!search) return [];
    const q = search.toLowerCase();
    return people
      .filter((p) => {
        const hay = [p.displayName, p.jobTitle].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      })
      .slice(0, 5);
  }, [people, search]);

  const reset = () => {
    setSearch("");
    setSelected(null);
    setMessage("");
    setValue("teamwork");
    setError(null);
    setOpen(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !message.trim()) return;
    setError(null);
    startCmsAction(startTransition, {
      action: () => sendKudos(selected.id, message.trim(), value),
      onSuccess: reset,
      // Keep the dialog (and its content) so the user can retry.
      onFailure: setError,
    });
  };

  return (
    <ModalDialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground outline-hidden transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Award className="h-4 w-4" aria-hidden="true" />
          {t("giveKudos")}
        </button>
      }
      title={t("giveKudos")}
    >
      <form onSubmit={handleSubmit}>
        <div className="mt-4 space-y-4">
          {/* Recipient picker */}
          <div>
            <label htmlFor={searchId} className="mb-1 block text-sm font-medium">
              {t("to")}
            </label>
            {selected ? (
              <div className="flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2">
                <Avatar className="h-7 w-7">
                  {selected.avatarUrl ? <AvatarImage src={selected.avatarUrl} alt="" /> : null}
                  <AvatarFallback className="text-xs">
                    {initials(selected.displayName)}
                  </AvatarFallback>
                </Avatar>
                <span className="text-sm font-medium">{selected.displayName}</span>
                <button
                  type="button"
                  onClick={() => {
                    setSelected(null);
                    setSearch("");
                  }}
                  aria-label={t("removeRecipient")}
                  className="ml-auto rounded-lg p-1 text-muted-foreground outline-hidden transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            ) : (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id={searchId}
                  type="text"
                  placeholder={t("searchColleague")}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  // Initial focus when the dialog opens.
                  autoFocus
                  className="h-10 w-full rounded-xl border bg-muted/40 pl-9 pr-3 text-sm outline-hidden placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring"
                />
                {filtered.length > 0 && (
                  <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-40 overflow-y-auto rounded-xl border bg-background shadow-lg">
                    {filtered.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setSelected(p);
                          setSearch("");
                          messageRef.current?.focus();
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm outline-hidden transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <Avatar className="h-7 w-7">
                          {p.avatarUrl ? (
                            <AvatarImage src={p.avatarUrl} alt="" loading="lazy" />
                          ) : null}
                          <AvatarFallback className="text-xs">
                            {initials(p.displayName)}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="font-medium">{p.displayName}</div>
                          {p.jobTitle && (
                            <div className="text-xs text-muted-foreground">{p.jobTitle}</div>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                <p role="status" className="sr-only">
                  {search ? t("searchResults", { count: filtered.length }) : ""}
                </p>
              </div>
            )}
          </div>

          {/* Value selector */}
          <fieldset>
            <legend className="mb-1 block text-sm font-medium">{t("for")}</legend>
            <div className="flex flex-wrap gap-2">
              {VALUES.map((v) => (
                <label
                  key={v.value}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background",
                    value === v.value
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "hover:border-border hover:bg-muted",
                  )}
                >
                  <input
                    type="radio"
                    name="kudos-value"
                    value={v.value}
                    checked={value === v.value}
                    onChange={() => setValue(v.value)}
                    className="sr-only"
                  />
                  <span aria-hidden="true">{v.emoji}</span>
                  {t(v.labelKey)}
                  {/* The pick is shown by a mark, not by colour alone. */}
                  {value === v.value && <Check className="h-3 w-3" aria-hidden="true" />}
                </label>
              ))}
            </div>
          </fieldset>

          {/* Message */}
          <div>
            <label htmlFor={messageId} className="mb-1 block text-sm font-medium">
              {t("message")}
            </label>
            <textarea
              id={messageId}
              ref={messageRef}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t("messagePlaceholder")}
              rows={3}
              className="w-full rounded-xl border bg-muted/40 px-4 py-2.5 text-sm outline-hidden placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {isSharedErrorCode(error) ? tErrors(error) : t("sendFailed")}
            </p>
          )}

          <button
            type="submit"
            disabled={!selected || !message.trim() || isPending}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground outline-hidden transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            {isPending ? t("sendingKudos") : t("sendKudos")}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
