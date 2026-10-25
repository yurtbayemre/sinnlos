"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type { UserAdminDetail } from "@sinnlos/domain";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { startCmsAction } from "@/lib/action-result";
import { resetUserMfa, sendLink } from "@/lib/manage/user-actions";

const LINK_ERRORS = [
  "notLocal",
  "blocked",
  "localSignInOff",
  "mailNotConfigured",
  "mailFailed",
] as const;
type LinkError = (typeof LINK_ERRORS)[number];
const linkError = (code: string): LinkError | "failed" =>
  (LINK_ERRORS as readonly string[]).includes(code) ? (code as LinkError) : "failed";

/**
 * A user's account on /manage/users/[id] (v0.27): whether a password and a
 * second factor are set, a new invitation or reset link by mail (local
 * accounts while local sign-in is on), and the reset of a lost second
 * factor (never your own: use your recovery codes or another admin).
 */
export function UserAccountActions({
  user,
  localSignIn,
}: {
  user: UserAdminDetail;
  localSignIn: boolean;
}) {
  const t = useTranslations("manage.users");
  const [pending, startTransition] = useTransition();
  const [confirm, setConfirm] = useState<"link" | "mfa" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const canLink = localSignIn && user.idp === null && !user.blocked;
  const canResetMfa = user.mfa && !user.self;

  // startCmsAction: a call that does not get through (a deploy restart, a
  // lost connection) shows the inline failure instead of the error page.
  const run = (kind: "link" | "mfa") => {
    setConfirm(null);
    if (kind === "link") {
      startCmsAction(startTransition, {
        action: () => sendLink(user.id),
        onSuccess: () =>
          setMessage({
            ok: true,
            text: t(user.invited ? "link.invitationSent" : "link.resetSent"),
          }),
        onFailure: (code) => setMessage({ ok: false, text: t(`link.error.${linkError(code)}`) }),
      });
      return;
    }
    startCmsAction(startTransition, {
      action: () => resetUserMfa(user.id),
      onSuccess: () => setMessage({ ok: true, text: t("mfaReset.done") }),
      onFailure: () => setMessage({ ok: false, text: t("mfaReset.failed") }),
    });
  };

  return (
    <section className="space-y-3 rounded-xl border p-4">
      <h2 className="text-sm font-medium">{t("account.title")}</h2>
      <ul className="space-y-1 text-sm text-muted-foreground">
        {user.idp === null && <li>{t(user.invited ? "account.invited" : "account.password")}</li>}
        <li>{t(user.mfa ? "account.mfaOn" : "account.mfaOff")}</li>
      </ul>
      <div className="flex flex-wrap gap-2">
        {canLink && (
          <ConfirmDialog
            open={confirm === "link"}
            onOpenChange={(open) => setConfirm(open ? "link" : null)}
            trigger={
              <Button type="button" variant="outline" size="sm" disabled={pending}>
                {t(user.invited ? "link.invitationButton" : "link.resetButton")}
              </Button>
            }
            title={t(user.invited ? "link.invitationTitle" : "link.resetTitle")}
            description={t(user.invited ? "link.invitationBody" : "link.resetBody")}
            confirmLabel={t("link.confirm")}
            tone="default"
            pending={pending}
            onConfirm={() => run("link")}
          />
        )}
        {canResetMfa && (
          <ConfirmDialog
            open={confirm === "mfa"}
            onOpenChange={(open) => setConfirm(open ? "mfa" : null)}
            trigger={
              <Button type="button" variant="outline" size="sm" disabled={pending}>
                {t("mfaReset.button")}
              </Button>
            }
            title={t("mfaReset.title")}
            description={t("mfaReset.body")}
            confirmLabel={t("mfaReset.confirm")}
            tone="destructive"
            pending={pending}
            onConfirm={() => run("mfa")}
          />
        )}
      </div>
      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          className={message.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
