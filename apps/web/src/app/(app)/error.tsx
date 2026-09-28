"use client";

import { useEffect, useRef } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Error boundary for the authenticated app. Handles unhandled Strapi or
 * render errors thrown from server components. List pages that want the
 * inline banner instead catch errors themselves with tryFetch(); the
 * detail pages let a failed read land here (WD07, architecture §5).
 *
 * Uses `retry()` (stable since Next 16.3), NOT `reset()`: reset only
 * re-renders the client tree without re-fetching server content, so
 * after a transient CMS outage "Try again" would stay stuck on the
 * error (SOTA-audit find, issue #30).
 *
 * Accessibility (UI04): the card is an alert (announced when it appears)
 * and focus moves to its heading, so keyboard and screen-reader users land
 * on the message instead of a control that no longer exists. The digest
 * is the reference that matches the server log line, as in global-error.
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations("errors");
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    console.error("[app] unhandled error", error);
  }, [error]);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <Card role="alert">
      <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <AlertTriangle className="h-6 w-6" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <h2 ref={headingRef} tabIndex={-1} className="font-medium outline-none">
            {t("somethingWrong")}
          </h2>
          <p className="max-w-sm text-sm text-muted-foreground">{t("somethingWrongHint")}</p>
          {error.digest ? (
            <p className="text-xs text-muted-foreground">
              {t("reference", { digest: error.digest })}
            </p>
          ) : null}
        </div>
        <Button onClick={() => retry()} variant="outline" size="sm">
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          {t("tryAgain")}
        </Button>
      </CardContent>
    </Card>
  );
}
