"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { signInWithCredentials, type SignInFormState } from "@/lib/auth-actions";
import { AUTH_FORM_MESSAGES } from "@/lib/auth/form-messages";

const inputClass =
  "h-10 w-full rounded-xl border bg-muted/40 px-4 text-sm outline-hidden placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring";

const ERROR_ID = "sign-in-error";

export function LocalSignInForm({ from = "/" }: { from?: string }) {
  const t = useTranslations("auth");
  const [state, formAction, isPending] = useActionState<SignInFormState, FormData>(
    signInWithCredentials,
    {},
  );
  // Controlled, so the password survives React 19's form reset when the
  // cms asks for the second factor and the form sends all three again.
  const [password, setPassword] = useState("");
  // The error names the fields it is about (S6): wrong credentials mark both
  // credential fields, a wrong code only the code field.
  const badCredentials = state.error === "invalidCredentials";
  const badCode = state.error === "mfaInvalid";

  return (
    <form action={formAction} className="space-y-3">
      {/* Validated deep-link target from ?from= — see sign-in/page.tsx. */}
      <input type="hidden" name="from" value={from} />
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
          // Echoed by a failed attempt: React 19 resets the form on every
          // settled submission (the password is never echoed).
          defaultValue={state.values?.identifier ?? ""}
          aria-invalid={badCredentials || undefined}
          aria-describedby={badCredentials ? ERROR_ID : undefined}
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
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={badCredentials || undefined}
          aria-describedby={badCredentials ? ERROR_ID : undefined}
          className={inputClass}
        />
      </div>
      {state.mfa && (
        <div>
          <p className="mb-2 text-sm text-muted-foreground">{t("mfaPrompt")}</p>
          <label htmlFor="otp" className="mb-1 block text-sm font-medium">
            {t("otp")}
          </label>
          <input
            id="otp"
            name="otp"
            type="text"
            inputMode="text"
            autoComplete="one-time-code"
            autoFocus
            required
            maxLength={32}
            aria-invalid={badCode || undefined}
            aria-describedby={badCode ? `otp-hint ${ERROR_ID}` : "otp-hint"}
            className={inputClass}
          />
          <p id="otp-hint" className="mt-1 text-xs text-muted-foreground">
            {t("otpHint")}
          </p>
        </div>
      )}
      {state.error && (
        <p id={ERROR_ID} role="alert" className="text-sm text-destructive">
          {t(AUTH_FORM_MESSAGES[state.error])}
        </p>
      )}
      <button
        type="submit"
        disabled={isPending}
        className="inline-flex w-full items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground outline-hidden transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
      >
        {isPending ? t("signingIn") : t("signIn")}
      </button>
    </form>
  );
}
