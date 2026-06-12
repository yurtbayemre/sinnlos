"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { changePassword, type ProfileFormState } from "@/lib/profile-actions";

const inputClass =
  "h-10 w-full rounded-xl border bg-muted/40 px-4 text-sm outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring";

export function ChangePasswordForm() {
  const t = useTranslations("profile");
  const tCommon = useTranslations("common");
  const [state, formAction, isPending] = useActionState<ProfileFormState, FormData>(
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
          minLength={6}
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
          minLength={6}
          className={inputClass}
        />
      </div>

      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      {state.success && <p className="text-sm text-emerald-600">{state.success}</p>}

      <button
        type="submit"
        disabled={isPending}
        className="inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
      >
        {isPending ? tCommon("saving") : t("changePassword")}
      </button>
    </form>
  );
}
