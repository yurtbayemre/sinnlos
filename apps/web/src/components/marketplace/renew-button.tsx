"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { RotateCw } from "lucide-react";
import { renewClassified } from "@/lib/classified-actions";

/**
 * Re-arms an expired ad for another 30 days. The action calls refresh(),
 * so the surrounding server-rendered list updates in the action response
 * (live-wrapper-free mutation pattern, like sendKudos).
 */
export function RenewButton({ id }: { id: number }) {
  const t = useTranslations("marketplace");
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            setError(false);
            const result = await renewClassified(id);
            if (result?.error) setError(true);
          })
        }
        className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
      >
        <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
        {isPending ? t("renewing") : t("renew")}
      </button>
      {error && (
        <span role="alert" className="text-xs text-destructive">
          {t("renewFailed")}
        </span>
      )}
    </span>
  );
}
