"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { Download } from "lucide-react";
import {
  ANONYMISE_DELETED,
  ANONYMISE_KEPT,
  type AnonymiseCounts,
  type UserAdminDetail,
} from "@sinnlos/domain";
import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/confirm-dialog";
import { startCmsAction } from "@/lib/action-result";
import {
  anonymiseUser,
  previewAnonymisation,
  type AnonymiseOutcome,
  type AnonymisePreview,
} from "@/lib/manage/user-actions";

const linkClass =
  "inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-sm font-medium outline-hidden transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * Data protection on /manage/users/[id] (v0.28, admin_role): the export of
 * everything stored about the person (Art. 15, a JSON download), their
 * training evidence (a CSV download, while the training module is on), and
 * the anonymisation (Art. 17) of a blocked person with a preview of what
 * goes and what stays and the username typed as the confirmation. The cms
 * checks every step again; an anonymised account shows its date only.
 */
export function UserDataProtection({
  user,
  trainingEvidence,
}: {
  user: UserAdminDetail;
  /** The training module is on (FEATURES_OFF): offer the evidence CSV. */
  trainingEvidence: boolean;
}) {
  const t = useTranslations("manage.users.dataProtection");
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<AnonymisePreview | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<AnonymiseOutcome | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const base = `/manage/users/${user.id}`;

  const errorText = (code: string) =>
    code === "notBlocked" || code === "anonymised" || code === "confirm"
      ? t(`error.${code}`)
      : t("error.failed");

  const openDialog = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setPreview(null);
    setTyped("");
    setError(null);
    // startCmsAction: a call that does not get through shows the inline
    // failure instead of the error page (v0.30).
    startCmsAction(startTransition, {
      action: () => previewAnonymisation(user.id),
      onSuccess: (data) => (data ? setPreview(data) : setError(errorText("failed"))),
      onFailure: (code) => setError(errorText(code)),
    });
  };

  const run = () => {
    if (!preview) return;
    setError(null);
    startCmsAction(startTransition, {
      action: () => anonymiseUser(user.id, typed),
      onSuccess: (data) => {
        if (!data) {
          setError(errorText("failed"));
          return;
        }
        setDone(data);
        setOpen(false);
      },
      onFailure: (code) => {
        if (code === "notBlocked" || code === "confirm") {
          setError(errorText(code));
          return;
        }
        // No answer (or an already anonymised person): the run may have
        // committed before the answer was lost, so read the account again;
        // an anonymised one replaces this dialog with its date.
        router.refresh();
        setError(code === "anonymised" ? errorText(code) : t("error.uncertain"));
      },
    });
  };

  const anonymisedAt = done?.anonymisedAt ?? user.anonymisedAt;
  // Notifications still naming the person when the request finished (v0.30:
  // the rewrite runs after the anonymisation committed; the nightly sweep
  // repeats what is left). A snapshot count, read as it comes.
  // null: the final count failed (some may be pending).
  const remaining = done ? done.notifications.remaining : 0;

  return (
    <section aria-labelledby="user-data-protection" className="space-y-3 rounded-xl border p-4">
      <h2 id="user-data-protection" className="text-sm font-medium">
        {t("title")}
      </h2>
      <div className="flex flex-wrap gap-2">
        <a href={`${base}/export`} download className={linkClass}>
          <Download className="h-4 w-4" aria-hidden="true" />
          {t("export")}
        </a>
        {trainingEvidence && (
          <a href={`${base}/evidence`} download className={linkClass}>
            <Download className="h-4 w-4" aria-hidden="true" />
            {t("evidence")}
          </a>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t("exportHint")}</p>

      {anonymisedAt ? (
        <p role="status" className="text-sm">
          {t("anonymisedAt", {
            date: format.dateTime(new Date(anonymisedAt), { dateStyle: "long" }),
          })}
        </p>
      ) : user.blocked ? (
        <ModalDialog
          open={open}
          onOpenChange={openDialog}
          trigger={
            <Button type="button" variant="destructive" size="sm" disabled={pending}>
              {t("anonymise.button")}
            </Button>
          }
          title={t("anonymise.title")}
          description={t("anonymise.body")}
          className="max-w-lg"
        >
          <div className="mt-4 space-y-4">
            {preview ? (
              <>
                <CountList title={t("anonymise.deleted")} counts={preview.counts} kind="deleted" />
                <p className="text-sm">
                  {t("anonymise.rewritten", { count: preview.counts.rewritten.notifications })}
                </p>
                <CountList title={t("anonymise.kept")} counts={preview.counts} kind="kept" />
                <p className="text-xs text-muted-foreground">{t("anonymise.evidenceNote")}</p>
                <label className="block space-y-1.5 text-sm">
                  <span>{t("anonymise.confirmLabel", { username: preview.username })}</span>
                  <input
                    value={typed}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={pending}
                    onChange={(e) => setTyped(e.target.value)}
                    className="w-full rounded-xl border bg-background px-3 py-2 text-sm"
                  />
                </label>
              </>
            ) : (
              !error && <p className="text-sm text-muted-foreground">{t("anonymise.loading")}</p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {t("anonymise.cancel")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={pending || !preview || typed.trim() !== preview.username}
                onClick={run}
              >
                {t("anonymise.confirm")}
              </Button>
            </div>
          </div>
        </ModalDialog>
      ) : (
        <p className="text-sm text-muted-foreground">{t("anonymise.blockFirst")}</p>
      )}

      {done && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("anonymise.done")}
          {remaining === null ? (
            <> {t("anonymise.remainingUnknown")}</>
          ) : (
            remaining > 0 && <> {t("anonymise.remaining", { count: remaining })}</>
          )}
          {done.avatar && !done.avatar.removed && (
            <> {t("anonymise.avatarKept", { id: done.avatar.id })}</>
          )}
        </p>
      )}
    </section>
  );
}

function CountList({
  title,
  counts,
  kind,
}: {
  title: string;
  counts: AnonymiseCounts;
  kind: "deleted" | "kept";
}) {
  const t = useTranslations("manage.users.dataProtection.classes");
  const classes = kind === "deleted" ? ANONYMISE_DELETED : ANONYMISE_KEPT;
  const values: Readonly<Record<string, number>> = counts[kind];
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-sm text-muted-foreground">
        {classes.map((name) => (
          <li key={name} className="flex justify-between gap-2">
            <span>{t(name)}</span>
            <span className="tabular-nums">{values[name] ?? 0}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
