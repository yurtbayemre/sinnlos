"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Error boundary for the authenticated app. Handles unhandled Strapi or
 * render errors thrown from server components. Pages that want the
 * inline banner instead should catch errors themselves with tryFetch().
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("errors");

  useEffect(() => {
    console.error("[app] unhandled error", error);
  }, [error]);

  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <div className="space-y-1">
          <p className="font-medium">{t("somethingWrong")}</p>
          <p className="max-w-sm text-sm text-muted-foreground">{t("somethingWrongHint")}</p>
        </div>
        <Button onClick={() => reset()} variant="outline" size="sm">
          <RefreshCw className="mr-2 h-4 w-4" />
          {t("tryAgain")}
        </Button>
      </CardContent>
    </Card>
  );
}
