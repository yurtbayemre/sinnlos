"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ROLE_PRIVILEGE_ORDER, type UserAdminDetail } from "@sinnlos/domain";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { OrgOptionsView } from "@/lib/loaders/manage/org";
import { fieldInputId } from "@/lib/manage/errors";
import { handRoleToEntra, saveUser } from "@/lib/manage/user-actions";
import { userValuesFromDetail, type UserValues } from "@/lib/manage/user-values";
import { ActionBar, FormAlert, useFieldError } from "./editor-chrome";
import { CheckboxField } from "./form-controls";
import { SinglePicker } from "./pickers";
import { useAuthoringEditor } from "./use-authoring-editor";
import { sameValues } from "./use-item-editor";

const FIELDS = ["role", "department", "manager", "blocked"];

/**
 * One user for admin_role (v0.23): role, department, manager, blocked. The
 * caller's own role and block are not theirs to change, and fields Entra's
 * sync owns for this user are shown read-only; the cms refuses both again.
 * An Entra-bound user with a hand-set role can be handed back to Entra.
 */
export function UserEditor({ user, options }: { user: UserAdminDetail; options: OrgOptionsView }) {
  const t = useTranslations("manage.users");
  const tc = useTranslations("manage.common");
  const [values, setValues] = useState(() => userValuesFromDetail(user));
  const [initial, setInitial] = useState(values);
  const [saved, setSaved] = useState(false);
  const [confirmHandBack, setConfirmHandBack] = useState(false);
  const formId = "user";
  const dirty = !sameValues(values, initial);
  const onReset = useCallback((source: UserAdminDetail) => {
    const fresh = userValuesFromDetail(source);
    setValues(fresh);
    setInitial(fresh);
    setSaved(false);
  }, []);
  const editor = useAuthoringEditor({
    formId,
    initialMeta: null,
    fieldOrder: FIELDS,
    source: user,
    onReset,
  });
  const error = useFieldError("users", editor.fieldErrors);
  const id = (field: string) => fieldInputId(formId, field);
  const setValue = <K extends keyof UserValues>(key: K, value: UserValues[K]) => {
    setValues((previous) => ({ ...previous, [key]: value }));
    setSaved(false);
  };
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const off = editor.pending;
  const pickersOff = off || options.failed;
  const save = () => {
    if (!dirty || off) return;
    const snapshot = values;
    editor.run("save", () => saveUser(user.id, snapshot, initial), {
      onSuccess: () => {
        setInitial(snapshot);
        setSaved(true);
      },
    });
  };
  const handBack = () => {
    setConfirmHandBack(false);
    editor.run("save", () => handRoleToEntra(user.id));
  };

  const people = options.people.filter((person) => person.id !== user.id);
  const managerOptions = [
    { value: "", label: t("fields.none") },
    ...people.map((person) => ({ value: String(person.id), label: person.label })),
    // A manager the directory no longer lists (blocked) stays visible by name.
    ...(user.manager && !people.some((person) => person.id === user.manager?.id)
      ? [{ value: String(user.manager.id), label: user.manager.displayName }]
      : []),
  ];
  const departmentOptions = [
    { value: "", label: t("fields.none") },
    ...options.departments.map((department) => ({
      value: department.documentId,
      label: department.name,
    })),
  ];
  const roleOptions = [
    ...(user.role === null ? [{ value: "", label: t("roles.none") }] : []),
    ...ROLE_PRIVILEGE_ORDER.map((role) => ({ value: role, label: t(`roles.${role}`) })),
  ];

  return (
    <form
      id={formId}
      noValidate
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{t("email")}</dt>
        <dd className="min-w-0 wrap-break-word">{user.email}</dd>
        <dt className="text-muted-foreground">{t("signIn")}</dt>
        <dd>{user.entraBound ? t("signInEntra") : t("signInLocal")}</dd>
      </dl>
      {user.self && <p className="text-sm text-muted-foreground">{t("selfHint")}</p>}
      {dirty && (
        <p className="text-sm text-amber-700 dark:text-amber-300">{tc("status.unsaved")}</p>
      )}
      {options.failed && <p className="text-sm text-destructive">{t("optionsFailed")}</p>}

      <div className="space-y-2">
        <SinglePicker
          id={id("role")}
          label={t("fields.role.label")}
          hint={user.entraBound ? t("fields.role.hint") : undefined}
          error={error("role")}
          value={values.role}
          options={roleOptions}
          disabled={off || user.self}
          onChange={(value) => setValue("role", value as UserValues["role"])}
        />
        {user.entraBound && (
          <p className="text-sm text-muted-foreground">
            {user.roleSource === "entra" ? t("roleSource.entra") : t("roleSource.manual")}
          </p>
        )}
        {user.entraBound && user.roleSource === "manual" && !user.self && (
          <ConfirmDialog
            open={confirmHandBack}
            onOpenChange={setConfirmHandBack}
            trigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={off || dirty}
                onClick={(event) => editor.rememberInvoker(event.currentTarget)}
              >
                {t("handBack.button")}
              </Button>
            }
            title={t("handBack.title")}
            description={t("handBack.body")}
            confirmLabel={t("handBack.confirm")}
            tone="default"
            pending={off}
            onConfirm={handBack}
          />
        )}
      </div>

      {user.locked.department ? (
        <LockedField
          id={id("department")}
          label={t("fields.department.label")}
          value={user.department?.name ?? t("fields.none")}
          hint={t("lockedHint")}
          error={error("department")}
        />
      ) : (
        <SinglePicker
          id={id("department")}
          label={t("fields.department.label")}
          error={error("department")}
          value={values.department}
          options={departmentOptions}
          disabled={pickersOff}
          onChange={(value) => setValue("department", value)}
        />
      )}

      {user.locked.manager ? (
        <LockedField
          id={id("manager")}
          label={t("fields.manager.label")}
          value={user.manager?.displayName ?? t("fields.none")}
          hint={t("lockedHint")}
          error={error("manager")}
        />
      ) : (
        <SinglePicker
          id={id("manager")}
          label={t("fields.manager.label")}
          error={error("manager")}
          value={values.manager === null ? "" : String(values.manager)}
          options={managerOptions}
          disabled={pickersOff}
          onChange={(value) => setValue("manager", value === "" ? null : Number(value))}
        />
      )}

      <CheckboxField
        id={id("blocked")}
        label={t("fields.blocked.label")}
        hint={t("fields.blocked.hint")}
        error={error("blocked")}
        checked={values.blocked}
        disabled={off || user.self}
        onChange={(checked) => setValue("blocked", checked)}
      />

      <div className="space-y-1.5">
        <h2 className="text-sm font-medium">{t("teams.label")}</h2>
        {user.teams.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("teams.none")}</p>
        ) : (
          <p className="text-sm">{user.teams.map((team) => team.name).join(", ")}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("teams.hint")}</p>
      </div>

      <FormAlert area="users" failure={editor.failure} alertRef={editor.alertRef} />
      <p role="status" className="text-sm text-muted-foreground">
        {saved && !dirty ? tc("success.saved") : ""}
      </p>
      <ActionBar label={tc("actions.toolbar")}>
        <Button type="submit" disabled={off || !dirty}>
          {off ? tc("actions.working") : tc("actions.save")}
        </Button>
        <Link href="/manage/users" className={buttonVariants({ variant: "ghost" })}>
          {tc("actions.backToList")}
        </Link>
      </ActionBar>
    </form>
  );
}

/** A field Entra's sync owns: shown, not editable; the id takes a refused save's focus. */
function LockedField({
  id,
  label,
  value,
  hint,
  error,
}: {
  id: string;
  label: string;
  value: string;
  hint: string;
  error?: string;
}) {
  return (
    <div className="space-y-1.5">
      <span id={`${id}-label`} className="block text-sm font-medium">
        {label}
      </span>
      <p
        id={id}
        tabIndex={-1}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        className="text-sm"
      >
        {value}
      </p>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
