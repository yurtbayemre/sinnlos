"use client";

import Link from "next/link";
import { useActionState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { PASSWORD_MIN_LENGTH } from "@sinnlos/domain";
import { linkTokenStore } from "@/lib/link-token";
import {
  requestPasswordReset,
  setPasswordFromLink,
  type ForgotPasswordState,
  type SetPasswordState,
} from "@/lib/password-actions";

const inputClass =
  "h-10 w-full rounded-xl border bg-muted/40 px-4 text-sm outline-hidden placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring";
const buttonClass =
  "inline-flex w-full items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground outline-hidden transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50";

/** Takes the focus once, when the element mounts in place of the form (S6). */
const focusOnMount = (element: HTMLElement | null) => element?.focus();

/** /forgot-password: one address, always the same neutral answer. */
export function ForgotPasswordForm() {
  const t = useTranslations("auth");
  const [state, action, isPending] = useActionState<ForgotPasswordState, FormData>(
    requestPasswordReset,
    {},
  );
  if (state.done) {
    return (
      <p role="status" tabIndex={-1} ref={focusOnMount} className="text-sm">
        {t("forgotDone")}
      </p>
    );
  }
  return (
    <form action={action} className="space-y-3">
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
          placeholder={t("emailPlaceholder")}
          className={inputClass}
        />
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {t("error_tooManyRequests")}
        </p>
      )}
      <button type="submit" disabled={isPending} className={buttonClass}>
        {t("forgotSubmit")}
      </button>
    </form>
  );
}

/**
 * /set-password: the token comes from the mail link's URL fragment
 * (lib/link-token.ts takes it and scrubs the address bar). A second link
 * opened in the same tab starts the form afresh (the key), with no error of
 * the first one left over.
 */
export function SetPasswordForm() {
  // null on the server and during hydration; the fragment's token after.
  const token = useSyncExternalStore(linkTokenStore.subscribe, linkTokenStore.read, () => null);
  if (token === null) return null;
  return <LinkPasswordForm key={token} token={token} />;
}

function LinkPasswordForm({ token }: { token: string }) {
  const t = useTranslations("auth");
  const [state, action, isPending] = useActionState<SetPasswordState, FormData>(
    setPasswordFromLink,
    {},
  );

  if (token === "" || state.error === "tokenInvalid") {
    return (
      <div className="space-y-3 text-sm">
        <p role="alert" className="text-destructive">
          {t("error_tokenInvalid")}
        </p>
        <Link href="/forgot-password" className="text-primary hover:underline">
          {t("forgotPassword")}
        </Link>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <div>
        <label htmlFor="password" className="mb-1 block text-sm font-medium">
          {t("newPassword")}
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          aria-describedby="password-rule"
          className={inputClass}
        />
        <p id="password-rule" className="mt-1 text-xs text-muted-foreground">
          {t("passwordRule", { min: PASSWORD_MIN_LENGTH })}
        </p>
      </div>
      <div>
        <label htmlFor="confirm" className="mb-1 block text-sm font-medium">
          {t("confirmPassword")}
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          className={inputClass}
        />
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(SET_PASSWORD_MESSAGES[state.error], { min: PASSWORD_MIN_LENGTH })}
        </p>
      )}
      <button type="submit" disabled={isPending} className={buttonClass}>
        {t("setPasswordSubmit")}
      </button>
    </form>
  );
}

/** The set-password codes → keys of the `auth` namespace. */
const SET_PASSWORD_MESSAGES = {
  tokenInvalid: "error_tokenInvalid",
  passwordTooShort: "error_passwordTooShort",
  passwordTooLong: "error_passwordTooLong",
  passwordCommon: "error_passwordCommon",
  passwordMismatch: "error_passwordMismatch",
  tooManyRequests: "error_tooManyRequests",
  setPasswordFailed: "error_setPasswordFailed",
} as const satisfies Record<NonNullable<SetPasswordState["error"]>, string>;
