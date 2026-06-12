"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { signInWithCredentials } from "@/lib/auth-actions";

const inputClass =
  "h-10 w-full rounded-xl border bg-muted/40 px-4 text-sm outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring";

export function LocalSignInForm() {
  const t = useTranslations("auth");
  const [state, formAction, isPending] = useActionState(signInWithCredentials, {
    error: undefined,
  });

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="identifier" className="mb-1 block text-sm font-medium">
          {t("email")}
        </label>
        <input
          id="identifier"
          name="identifier"
          type="email"
          autoComplete="email"
          required
          placeholder={t("emailPlaceholder")}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="password" className="mb-1 block text-sm font-medium">
          {t("password")}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </div>
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      <button
        type="submit"
        disabled={isPending}
        className="inline-flex w-full items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
      >
        {isPending ? t("signingIn") : t("signIn")}
      </button>
    </form>
  );
}
