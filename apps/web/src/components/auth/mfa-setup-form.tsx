"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { activateMfa, type MfaActivateState } from "@/lib/mfa-actions";

const inputClass =
  "h-10 w-full rounded-xl border bg-muted/40 px-4 text-sm outline-hidden placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring";
const buttonClass =
  "inline-flex w-full items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground outline-hidden transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50";

/**
 * The code from the app and the current password (v0.27: every
 * activation needs it), then the recovery codes, shown this once. The
 * session already carries the new JWT when they appear, so the app the
 * button opens renders for the unrestricted session.
 */
export function MfaSetupForm({ enrollment, enrolled }: { enrollment: string; enrolled: boolean }) {
  const t = useTranslations("mfa");
  const router = useRouter();
  const [state, action, isPending] = useActionState<MfaActivateState, FormData>(activateMfa, {});

  if (state.recoveryCodes) {
    return (
      <div className="space-y-3">
        <h2 className="text-base font-semibold">{t("recoveryTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("recoveryDesc")}</p>
        <ul className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/40 p-3 font-mono text-sm">
          {state.recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <button type="button" onClick={() => router.replace("/")} className={buttonClass}>
          {t("recoverySaved")}
        </button>
      </div>
    );
  }

  if (enrolled) {
    return (
      <p className="text-sm">
        {t("alreadyOn")}{" "}
        <Link href="/profile" className="text-primary hover:underline">
          {t("toProfile")}
        </Link>
      </p>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="enrollment" value={enrollment} />
      <p className="text-sm">{t("step2")}</p>
      <div>
        <label htmlFor="mfa-code" className="mb-1 block text-sm font-medium">
          {t("code")}
        </label>
        <input
          id="mfa-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          required
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="mfa-password" className="mb-1 block text-sm font-medium">
          {t("password")}
        </label>
        <input
          id="mfa-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {t(`error_${state.error}`)}
        </p>
      )}
      <button type="submit" disabled={isPending} className={buttonClass}>
        {t("activate")}
      </button>
    </form>
  );
}
