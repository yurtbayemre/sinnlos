"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { Search, Send, X } from "lucide-react";
import {
  DEFAULT_SECRET_SHARE_LIFETIME,
  SECRET_SHARE_LIFETIMES,
  SECRET_TEXT_MAX_BYTES,
  isSecretText,
  type SecretShareLifetime,
  type SecretShareRecipient,
} from "@sinnlos/domain";
import { Button } from "@/components/ui/button";
import { startCmsAction } from "@/lib/action-result";
import { createSecret, findSecretRecipients } from "@/lib/secret-actions";
import type { SecretCode } from "@/lib/secret-share-errors";
import { useCleanDocument } from "@/components/secrets/clean-document";
import { SecretError } from "@/components/secrets/secret-error";

/** How long the picker waits after the last keystroke before it asks the cms. */
const SEARCH_DELAY_MS = 250;

const LIFETIME_KEY = { "1h": "lifetime1h", "24h": "lifetime24h" } as const;

/**
 * The form of /secrets/new: one colleague (picked from the cms's recipients
 * search: eligible staff, never oneself), the text (no autocomplete, no
 * spell check: a password must not reach a dictionary service) and the
 * lifetime. A sent secret clears the form and opens the share's page. A
 * `busy` answer keeps the form and points to the sent list: the share may
 * exist (SecretError). Nothing can be typed until the document is known to
 * be free of analytics (useCleanDocument; a tab that loaded Plausible
 * reloads first).
 */
export function NewSecretForm() {
  const t = useTranslations("secrets");
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SecretShareRecipient[]>([]);
  const [searchError, setSearchError] = useState<SecretCode | null>(null);
  const [recipient, setRecipient] = useState<SecretShareRecipient | null>(null);
  const [text, setText] = useState("");
  const [lifetime, setLifetime] = useState<SecretShareLifetime>(DEFAULT_SECRET_SHARE_LIFETIME);
  const [error, setError] = useState<SecretCode | null>(null);
  const [isPending, startTransition] = useTransition();
  const clean = useCleanDocument();
  const searchId = useId();
  const textId = useId();
  // The latest search wins: an older answer that arrives late is dropped.
  const latestSearch = useRef(0);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(searchTimer.current), []);

  const search = (value: string) => {
    setQuery(value);
    clearTimeout(searchTimer.current);
    const term = value.trim();
    const mine = ++latestSearch.current;
    if (!term) {
      setResults([]);
      setSearchError(null);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      const result = await findSecretRecipients(term).catch(() => null);
      if (mine !== latestSearch.current) return;
      setResults(result?.ok ? (result.data ?? []) : []);
      setSearchError(result === null ? "unavailable" : result.ok ? null : result.code);
    }, SEARCH_DELAY_MS);
  };

  const bytes = new TextEncoder().encode(text).length;
  const tooLong = bytes > SECRET_TEXT_MAX_BYTES;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!recipient || !isSecretText(text)) return;
    setError(null);
    startCmsAction(startTransition, {
      action: () => createSecret(recipient.id, text, lifetime),
      onSuccess: (data) => {
        setText("");
        router.push((data ? `/secrets/${data.id}` : "/secrets") as Route);
      },
      onFailure: setError,
    });
  };

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-6">
      <fieldset disabled={isPending || !clean} className="min-w-0 space-y-6">
        <div>
          <label htmlFor={searchId} className="mb-1 block text-sm font-medium">
            {t("to")}
          </label>
          {recipient ? (
            <div className="flex items-center gap-2 rounded-xl border bg-muted/40 px-3 py-2">
              <span className="text-sm font-medium">{recipient.displayName}</span>
              {recipient.department && (
                <span className="text-xs text-muted-foreground">{recipient.department}</span>
              )}
              <button
                type="button"
                onClick={() => setRecipient(null)}
                aria-label={t("removeRecipient")}
                className="ml-auto rounded-lg p-1 text-muted-foreground outline-hidden transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
                value={query}
                onChange={(e) => search(e.target.value)}
                placeholder={t("searchColleague")}
                autoComplete="off"
                autoFocus
                className="h-10 w-full rounded-xl border bg-muted/40 pl-9 pr-3 text-sm outline-hidden placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring"
              />
              {results.length > 0 && (
                <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-60 overflow-y-auto rounded-xl border bg-background shadow-lg">
                  {results.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setRecipient(p);
                        search("");
                      }}
                      className="flex w-full flex-col px-3 py-2 text-left text-sm outline-hidden transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    >
                      <span className="font-medium">{p.displayName}</span>
                      {p.department && (
                        <span className="text-xs text-muted-foreground">{p.department}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <p role="status" className="sr-only">
                {query.trim() ? t("searchResults", { count: results.length }) : ""}
              </p>
              {searchError && <SecretError code={searchError} action="search" />}
            </div>
          )}
        </div>

        <div>
          <label htmlFor={textId} className="mb-1 block text-sm font-medium">
            {t("text")}
          </label>
          <textarea
            id={textId}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${textId}-hint`}
            className="w-full rounded-xl border bg-muted/40 px-4 py-2.5 font-mono text-sm outline-hidden focus:bg-background focus:ring-2 focus:ring-ring"
          />
          <p
            id={`${textId}-hint`}
            className={tooLong ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
          >
            {t("textHint", { bytes, max: SECRET_TEXT_MAX_BYTES })}
          </p>
        </div>

        <fieldset>
          <legend className="mb-1 block text-sm font-medium">{t("lifetime")}</legend>
          <div className="flex flex-wrap gap-4">
            {SECRET_SHARE_LIFETIMES.map((value) => (
              <label key={value} className="inline-flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="secret-lifetime"
                  value={value}
                  checked={lifetime === value}
                  onChange={() => setLifetime(value)}
                />
                {t(LIFETIME_KEY[value])}
              </label>
            ))}
          </div>
        </fieldset>
      </fieldset>

      {error && <SecretError code={error} action="create" />}

      <Button type="submit" disabled={!recipient || !isSecretText(text) || isPending || !clean}>
        <Send className="h-4 w-4" aria-hidden="true" />
        {isPending ? t("sending") : t("send")}
      </Button>
    </form>
  );
}
