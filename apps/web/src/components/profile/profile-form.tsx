"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { updateProfile, type ProfileFormState } from "@/lib/profile-actions";
import { PROFILE_FORM_MESSAGES, PROFILE_TEXT_MAX } from "@/lib/auth/form-messages";

const inputClass =
  "h-10 w-full rounded-xl border bg-muted/40 px-4 text-sm outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring";

export type ProfileInitial = {
  displayName?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  officeLocation?: string | null;
  birthday?: string | null;
  birthdayVisible?: boolean | null;
  digestAnnouncements?: boolean | null;
  digestMentions?: boolean | null;
  digestKudos?: boolean | null;
  digestFrequency?: string | null;
};

/**
 * Roles that get e-mail digests: the holders of announcement.find in the
 * cms matrix (apps/cms/src/index.ts PERMISSION_MATRIX). The cms decides
 * (send-digests skips guests, PUT /api/me ignores their opt-ins, FX19); this
 * only keeps the form from offering what the cms ignores. Fail-closed like
 * lib/roles.ts: an unknown or missing role sees no digest options. A
 * component-local copy like the report pages' ANNOUNCEMENT_READER_ROLES
 * until SH02 moves the role sets into one place.
 */
export const DIGEST_ROLES: ReadonlySet<string> = new Set([
  "admin_role",
  "editor",
  "department_head",
  "team_lead",
  "member",
  "authenticated",
]);

/** The digest checkboxes (the frequency is the fourth digest field). */
const DIGEST_OPT_INS = ["digestAnnouncements", "digestMentions", "digestKudos"] as const;

/** The free-text fields; the Microsoft Entra sign-in may own them (managedFields). */
const TEXT_INPUTS = [
  { name: "displayName", type: "text" },
  { name: "jobTitle", type: "text" },
  { name: "phone", type: "tel" },
  { name: "officeLocation", type: "text" },
] as const;

export function ProfileForm({
  initial,
  viewerRole,
  managedFields = [],
}: {
  initial: ProfileInitial;
  /** The viewer's role type from GET /api/me; decides whether the digest options show. */
  viewerRole?: string | null;
  /**
   * GET /api/me `entraManagedFields` (D-ENTRA-01): the fields the Microsoft
   * Entra sign-in keeps in sync. They render read-only; a disabled input is
   * not submitted, and PUT /api/me ignores them for such a user anyway.
   */
  managedFields?: readonly string[];
}) {
  const showDigest = typeof viewerRole === "string" && DIGEST_ROLES.has(viewerRole);
  const managed = new Set(managedFields);
  const tProfile = useTranslations("profile");
  const tCommon = useTranslations("common");
  const [state, formAction, isPending] = useActionState<ProfileFormState, FormData>(
    updateProfile,
    {},
  );
  // Submitted values echoed back by a failed action — React 19 resets the
  // form after every settled submission; without this a transient CMS
  // error silently reverted everything typed (issue #30).
  const v = state.values;

  return (
    <form action={formAction} className="space-y-4">
      {TEXT_INPUTS.some(({ name }) => managed.has(name)) && (
        <p id="entra-managed-hint" className="text-xs text-muted-foreground">
          {tProfile("entraManagedHint")}
        </p>
      )}
      {TEXT_INPUTS.map(({ name, type }) => {
        const locked = managed.has(name);
        return (
          <div key={name}>
            <label htmlFor={name} className="mb-1 block text-sm font-medium">
              {tProfile(name)}
            </label>
            <input
              id={name}
              name={name}
              type={type}
              // A locked field always shows the stored value: the echo of a
              // failed save carries "" for it (a disabled input is not sent).
              defaultValue={(locked ? initial[name] : (v?.[name] ?? initial[name])) ?? ""}
              disabled={locked}
              aria-describedby={locked ? "entra-managed-hint" : undefined}
              className={`${inputClass} disabled:cursor-not-allowed disabled:opacity-70`}
            />
          </div>
        );
      })}
      <div>
        <label htmlFor="birthday" className="mb-1 block text-sm font-medium">
          {tProfile("birthday")}
        </label>
        <input
          id="birthday"
          name="birthday"
          type="date"
          defaultValue={v?.birthday ?? initial.birthday ?? ""}
          className={inputClass}
        />
      </div>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          name="birthdayVisible"
          defaultChecked={v?.birthdayVisible ?? initial.birthdayVisible ?? false}
          className="mt-0.5 h-4 w-4 rounded border accent-primary"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{tProfile("birthdayVisible")}</span>
          <span className="block text-xs text-muted-foreground">
            {tProfile("birthdayVisibleHint")}
          </span>
        </span>
      </label>

      {!showDigest && (
        // Not offered, but submitted as stored: updateProfile maps an absent
        // checkbox to false, so without these a save would clear the opt-ins
        // of a reader whose role could not be read (or a role this copy does
        // not know yet). The cms ignores them for guests.
        <>
          {DIGEST_OPT_INS.map((name) =>
            (v ? v[name] : initial[name]) === true ? (
              <input key={name} type="hidden" name={name} value="on" />
            ) : null,
          )}
          <input
            type="hidden"
            name="digestFrequency"
            value={(v?.digestFrequency ?? initial.digestFrequency) === "daily" ? "daily" : "weekly"}
          />
        </>
      )}
      {showDigest && (
        <fieldset className="space-y-3 rounded-xl border p-4">
          <legend className="px-1 text-sm font-medium">{tProfile("digestSection")}</legend>
          <p className="text-xs text-muted-foreground">{tProfile("digestHint")}</p>
          {(
            [
              ["digestAnnouncements", initial.digestAnnouncements],
              ["digestMentions", initial.digestMentions],
              ["digestKudos", initial.digestKudos],
            ] as const
          ).map(([name, checked]) => (
            <label key={name} className="flex items-start gap-3">
              <input
                type="checkbox"
                name={name}
                defaultChecked={(v ? v[name] : checked) ?? false}
                className="mt-0.5 h-4 w-4 rounded border accent-primary"
              />
              <span className="block text-sm">{tProfile(name)}</span>
            </label>
          ))}
          <div
            className="flex gap-6 pt-1"
            role="radiogroup"
            aria-label={tProfile("digestFrequency")}
          >
            {(["weekly", "daily"] as const).map((freq) => (
              <label key={freq} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="digestFrequency"
                  value={freq}
                  defaultChecked={
                    (v?.digestFrequency ?? initial.digestFrequency ?? "weekly") === freq
                  }
                  className="h-4 w-4 accent-primary"
                />
                {tProfile(`digestFrequency_${freq}`)}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error === "tooLong"
            ? tProfile(PROFILE_FORM_MESSAGES.tooLong, {
                field: state.field ? tProfile(state.field) : "",
                max: PROFILE_TEXT_MAX,
              })
            : tProfile(PROFILE_FORM_MESSAGES[state.error])}
        </p>
      )}
      {state.success && (
        <p role="status" className="text-sm text-emerald-600 dark:text-emerald-400">
          {tProfile(PROFILE_FORM_MESSAGES[state.success])}
        </p>
      )}

      <button
        type="submit"
        disabled={isPending}
        className="inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
      >
        {isPending ? tCommon("saving") : tCommon("save")}
      </button>
    </form>
  );
}
