"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startCmsAction } from "@/lib/action-result";
import { revokeSecret } from "@/lib/secret-actions";
import { settleSecretCall, type SecretCode } from "@/lib/secret-share-errors";
import { SecretError } from "@/components/secrets/secret-error";

/**
 * Revokes a pending secret of the sender. The page renders it only for
 * `state === "pending"` (also while the recipient is unavailable), and it
 * is disabled while its own request runs; the action re-renders the page.
 */
export function RevokeSecret({ id }: { id: string }) {
  const t = useTranslations("secrets");
  const [error, setError] = useState<SecretCode | null>(null);
  const [isPending, startTransition] = useTransition();

  const revoke = () => {
    setError(null);
    startCmsAction(startTransition, {
      action: () => settleSecretCall(revokeSecret(id)),
      onFailure: setError,
    });
  };

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" size="sm" onClick={revoke} disabled={isPending}>
        <Ban className="h-4 w-4" aria-hidden="true" />
        {isPending ? t("revoking") : t("revoke")}
      </Button>
      {error && <SecretError code={error} action="revoke" />}
    </div>
  );
}
