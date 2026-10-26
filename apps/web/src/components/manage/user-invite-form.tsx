"use client";

import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { ROLE_PRIVILEGE_ORDER, type RoleType } from "@sinnlos/domain";
import { Button, buttonVariants } from "@/components/ui/button";
import type { OrgOptionsView } from "@/lib/loaders/manage/org";
import { inviteUser, type InviteOutcome } from "@/lib/manage/user-actions";
import { Field, inputClass } from "./form-controls";
import { SinglePicker } from "./pickers";

/** At most this many lines per send (one cms request each). */
export const INVITE_MAX_LINES = 100;

export type InviteLine = { email: string; name: string; valid: boolean };

/**
 * One person per line, `email` or `email;name` (S3): one address is a
 * single invitation, many are the bulk form. Blank lines are skipped, a
 * repeated address is invalid the second time. Nothing is cut: the form
 * refuses more than INVITE_MAX_LINES lines (#184).
 */
export function parseInviteLines(text: string): InviteLine[] {
  const seen = new Set<string>();
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [rawEmail = "", ...rest] = line.split(";");
      const email = rawEmail.trim();
      const key = email.toLowerCase();
      const valid = /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(email) && !seen.has(key);
      seen.add(key);
      return { email, name: rest.join(";").trim(), valid };
    });
}

export type InviteRow = InviteLine & { outcome?: InviteOutcome };
type Row = InviteRow;

/** A row still to send: valid and not yet answered, or failed in transit. */
export const isOpen = (row: InviteRow) => row.valid && (!row.outcome || row.outcome === "failed");

/**
 * Sends the open rows one after the other. A call that throws (the action
 * never answered) marks its row failed, so it stays open for the next try,
 * and the rest still go out.
 */
export async function sendOpenInvites(
  rows: readonly InviteRow[],
  invite: (row: InviteRow) => Promise<InviteOutcome>,
  onResult: (index: number, outcome: InviteOutcome) => void,
): Promise<void> {
  for (const [index, row] of rows.entries()) {
    if (!isOpen(row)) continue;
    let outcome: InviteOutcome;
    try {
      outcome = await invite(row);
    } catch {
      outcome = "failed";
    }
    onResult(index, outcome);
  }
}

/**
 * /manage/users/invite (v0.27): addresses, one role and one department for
 * all of them, a preview, then one invitation per line with its result.
 */
export function UserInviteForm({ options }: { options: OrgOptionsView }) {
  const t = useTranslations("manage.users");
  const [text, setText] = useState("");
  const [role, setRole] = useState<RoleType>("member");
  const [department, setDepartment] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sending, setSending] = useState(false);
  /** The line count of a list over INVITE_MAX_LINES, refused as a whole. */
  const [tooMany, setTooMany] = useState<number | null>(null);
  const openCount = rows?.filter(isOpen).length ?? 0;
  const done = rows !== null && openCount === 0;

  const send = async () => {
    if (!rows) return;
    setSending(true);
    try {
      await sendOpenInvites(
        rows,
        (row) =>
          inviteUser({
            email: row.email,
            displayName: row.name,
            role,
            department: department || null,
          }),
        (index, outcome) =>
          setRows((current) =>
            current ? current.map((r, i) => (i === index ? { ...r, outcome } : r)) : current,
          ),
      );
    } finally {
      setSending(false);
    }
  };

  if (rows) {
    return (
      <div className="space-y-4">
        <ul className="divide-y rounded-xl border text-sm">
          {rows.map((row, index) => (
            <li key={index} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
              <span className="min-w-0 flex-1 wrap-break-word">
                {row.email}
                {row.name && <span className="text-muted-foreground"> · {row.name}</span>}
              </span>
              <span
                className={
                  !row.valid || (row.outcome && row.outcome !== "sent")
                    ? "text-destructive"
                    : "text-muted-foreground"
                }
              >
                {!row.valid
                  ? t("invite.lineInvalid")
                  : row.outcome
                    ? t(`invite.outcome.${row.outcome}`)
                    : t("invite.pending")}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          {done ? (
            <>
              <Button
                type="button"
                onClick={() => {
                  setRows(null);
                  setText("");
                }}
              >
                {t("invite.more")}
              </Button>
              <Link href="/manage/users" className={buttonVariants({ variant: "ghost" })}>
                {t("invite.toList")}
              </Link>
            </>
          ) : (
            <>
              <Button type="button" disabled={sending || openCount === 0} onClick={send}>
                {t("invite.send", { count: openCount })}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={sending}
                onClick={() => setRows(null)}
              >
                {t("invite.edit")}
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        const lines = parseInviteLines(text);
        if (lines.length > INVITE_MAX_LINES) {
          setTooMany(lines.length);
          return;
        }
        setTooMany(null);
        if (lines.length > 0) setRows(lines);
      }}
    >
      <Field
        id="invite-lines"
        label={t("invite.lines")}
        hint={t("invite.linesHint")}
        error={
          tooMany === null
            ? undefined
            : t("invite.tooMany", { count: tooMany, max: INVITE_MAX_LINES })
        }
        required
      >
        {(a11y) => (
          <textarea
            {...a11y}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setTooMany(null);
            }}
            rows={6}
            placeholder={t("invite.linesPlaceholder")}
            className={`${inputClass} h-auto min-h-32 py-2 font-mono`}
          />
        )}
      </Field>
      <SinglePicker
        id="invite-role"
        label={t("fields.role.label")}
        value={role}
        options={ROLE_PRIVILEGE_ORDER.map((r) => ({ value: r, label: t(`roles.${r}`) }))}
        onChange={(value) => setRole(value as RoleType)}
      />
      <SinglePicker
        id="invite-department"
        label={t("fields.department.label")}
        value={department}
        options={[
          { value: "", label: t("fields.none") },
          ...options.departments.map((d) => ({ value: d.documentId, label: d.name })),
        ]}
        disabled={options.failed}
        onChange={setDepartment}
      />
      <Button type="submit">{t("invite.preview")}</Button>
    </form>
  );
}
