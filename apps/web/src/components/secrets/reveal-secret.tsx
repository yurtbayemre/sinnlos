"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { unstable_rethrow } from "next/navigation";
import { Copy, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { actionFailure, type ActionFailure } from "@/lib/action-result";
import { revealSecret } from "@/lib/secret-actions";
import type { SecretCode } from "@/lib/secret-share-errors";
import { SecretError } from "@/components/secrets/secret-error";

/**
 * Whether this document ever loaded the Plausible script: a tab opened
 * while the module secrets was off keeps it across client navigation after
 * the operator switched secrets on (the root layout renders it no more).
 */
function documentHasAnalytics(): boolean {
  return "plausible" in window || document.querySelector("script[data-domain]") !== null;
}

/**
 * The state of "Show and delete" (v0.35, plan §3.10). The text exists only
 * here, filled by the click's own Server Action result: no refresh(), no
 * server props, no form state. It goes on `pagehide` (also into the
 * back/forward cache) and on unmount, and a result that arrives after
 * either is dropped: every click, pagehide and unmount moves `generation`
 * on, and a result applies only to the generation it started in. In a
 * document that loaded Plausible the click reloads the page instead: the
 * fresh document has no analytics, and the click there reveals.
 */
export function useRevealSecret(id: string) {
  const [text, setText] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<ActionFailure<SecretCode> | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const forget = () => {
      generation.current += 1;
      setText(null);
      setPending(false);
    };
    window.addEventListener("pagehide", forget);
    return () => {
      window.removeEventListener("pagehide", forget);
      generation.current += 1;
    };
  }, []);

  const reveal = async () => {
    if (documentHasAnalytics()) {
      window.location.reload();
      return;
    }
    const mine = ++generation.current;
    setPending(true);
    setFailure(null);
    let result: Awaited<ReturnType<typeof revealSecret>>;
    try {
      result = await revealSecret(id);
    } catch (error) {
      // The sign-in redirect of an expired session is Next's to handle.
      unstable_rethrow(error);
      result = actionFailure("unavailable");
    }
    if (mine !== generation.current) return;
    setPending(false);
    if (result.ok && result.data) setText(result.data.text);
    else if (!result.ok) setFailure(result);
  };

  return { text, pending, failure, reveal };
}

export function RevealSecret({ id }: { id: string }) {
  const t = useTranslations("secrets");
  const { text, pending, failure, reveal } = useRevealSecret(id);
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (text === null) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (text !== null) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("revealedHint")}</p>
        <pre
          data-testid="secret-text"
          className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-xl border bg-muted/40 p-4 font-mono text-sm"
        >
          {text}
        </pre>
        <Button type="button" variant="outline" onClick={copy}>
          <Copy className="h-4 w-4" aria-hidden="true" />
          {copied ? t("copied") : t("copy")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t("revealHint")}</p>
      <Button type="button" onClick={reveal} disabled={pending}>
        <Eye className="h-4 w-4" aria-hidden="true" />
        {pending ? t("revealing") : t("reveal")}
      </Button>
      {failure && <SecretError code={failure.code} action="reveal" />}
    </div>
  );
}
