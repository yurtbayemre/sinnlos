"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { isSharedErrorCode } from "@/lib/action-result";
import type { SecretCode } from "@/lib/secret-share-errors";

type SecretAction = "create" | "reveal" | "revoke" | "search";

/** The text of each refusal (namespace secrets.errors); `busy` depends on the action. */
const REFUSAL_KEY = {
  recipient: "recipient",
  text: "text",
  lifetime: "lifetime",
  quota: "quota",
  gone: "gone",
  partyIneligible: "partyIneligible",
  noKey: "noKey",
  cancelled: "cancelled",
} as const;

const BUSY_KEY = {
  create: "busyCreate",
  reveal: "busyReveal",
  revoke: "busyRevoke",
  search: "failed",
} as const;

/**
 * A failed secret action, in words. A `busy` create has an unknown outcome
 * (the share may exist: a lost COMMIT acknowledgement), so the sender is
 * sent to the sent list before sending again.
 */
export function SecretError({ code, action }: { code: SecretCode; action: SecretAction }) {
  const t = useTranslations("secrets.errors");
  const tErrors = useTranslations("actionErrors");
  const message =
    code === "busy"
      ? t(BUSY_KEY[action])
      : Object.hasOwn(REFUSAL_KEY, code)
        ? t(REFUSAL_KEY[code as keyof typeof REFUSAL_KEY])
        : isSharedErrorCode(code)
          ? tErrors(code)
          : t("failed");
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
      {code === "busy" && action === "create" && (
        <>
          {" "}
          <Link href="/secrets" className="font-medium underline">
            {t("openSent")}
          </Link>
        </>
      )}
    </p>
  );
}
