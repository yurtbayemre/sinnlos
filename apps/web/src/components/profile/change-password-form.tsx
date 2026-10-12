"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { changePassword, type PasswordFormState } from "@/lib/profile-actions";
import { PASSWORD_MIN_LENGTH, PROFILE_FORM_MESSAGES } from "@/lib/auth/form-messages";

const inputClass =
  "h-10 w-full rounded-xl border bg-muted/40 px-4 text-sm outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring";

export function ChangePasswordForm() {
  const t = useTranslations("profile");
  const tCommon = useTranslations("common");
  const [state, formAction, isPending] = useActionState<PasswordFormState, FormData>(
    changePassword,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="currentPassword" className="mb-1 block text-sm font-medium">
          {t("currentPassword")}
        </label>
        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="newPassword" className="mb-1 block text-sm font-medium">
          {t("newPassword")}
        </label>
        <input
          id="newPassword"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="passwordConfirmation" className="mb-1 block text-sm font-medium">
          {t("confirmPassword")}
        </label>
        <input
          id="passwordConfirmation"
          name="passwordConfirmation"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          className={inputClass}
        />
      </div>

      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error === "passwordTooShort"
            ? t(PROFILE_FORM_MESSAGES.passwordTooShort, { min: PASSWORD_MIN_LENGTH })
            : t(PROFILE_FORM_MESSAGES[state.error])}
        </p>
      )}
      {state.success && (
        <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
          {t(PROFILE_FORM_MESSAGES[state.success])}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
      >
        {isPending ? tCommon("saving") : t("changePassword")}
      </button>
    </form>
  );
}
