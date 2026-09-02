"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { registerLocalAccount, type RegisterFormState } from "@/lib/auth-actions";

const inputClass =
  "h-10 w-full rounded-xl border bg-muted/40 px-4 text-sm outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring";

export function RegisterForm() {
  const t = useTranslations("auth");
  const [state, formAction, isPending] = useActionState<RegisterFormState, FormData>(
    registerLocalAccount,
    {},
  );
  // Values echoed back by a failed action — React 19 resets the form on
  // every settled submission, this restores what the user typed (the
  // password is never echoed and must be re-entered on error).
  const v = state.values;

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="username" className="mb-1 block text-sm font-medium">
          {t("name")}
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autoComplete="name"
          required
          defaultValue={v?.username ?? ""}
          placeholder={t("namePlaceholder")}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium">
          {t("email")}
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={v?.email ?? ""}
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
          autoComplete="new-password"
          required
          minLength={6}
          className={inputClass}
        />
      </div>
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      <button
        type="submit"
        disabled={isPending}
        className="inline-flex w-full items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
      >
        {isPending ? t("creatingAccount") : t("createAccount")}
      </button>
    </form>
  );
}
