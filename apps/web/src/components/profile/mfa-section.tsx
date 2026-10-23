"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { disableMfa, type MfaDisableState } from "@/lib/mfa-actions";

const inputClass =
  "h-10 w-full rounded-xl border bg-muted/40 px-4 text-sm outline-hidden placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring";

/**
 * /profile, v0.27: the second factor of a local account. Off → a link to
 * /mfa/setup; on → a code and the password turn it off (the cms refuses
 * that while the role requires it: error requiredByRole).
 */
export function MfaSection({ enrolled }: { enrolled: boolean }) {
  const t = useTranslations("profile");
  const tMfa = useTranslations("mfa");
  const [state, action, isPending] = useActionState<MfaDisableState, FormData>(disableMfa, {});

  if (state.success) {
    return (
      <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
        {t("mfaDisabled")}
      </p>
    );
  }
  if (!enrolled) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("mfaOff")}</p>
        <Link
          href="/mfa/setup"
          className="inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t("mfaSetUp")}
        </Link>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-3">
      <p className="text-sm">{t("mfaOn")}</p>
      <p className="text-sm text-muted-foreground">{t("mfaDisableDesc")}</p>
      <div>
        <label htmlFor="mfa-disable-code" className="mb-1 block text-sm font-medium">
          {tMfa("code")}
        </label>
        <input
          id="mfa-disable-code"
          name="code"
          type="text"
          autoComplete="one-time-code"
          maxLength={32}
          required
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="mfa-disable-password" className="mb-1 block text-sm font-medium">
          {tMfa("password")}
        </label>
        <input
          id="mfa-disable-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {tMfa(`error_${state.error}`)}
        </p>
      )}
      <button
        type="submit"
        disabled={isPending}
        className="inline-flex items-center justify-center rounded-xl border px-4 py-2.5 text-sm font-medium hover:bg-muted disabled:opacity-50"
      >
        {t("mfaDisable")}
      </button>
    </form>
  );
}
