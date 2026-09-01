"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { updateProfile, type ProfileFormState } from "@/lib/profile-actions";

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

export function ProfileForm({ initial }: { initial: ProfileInitial }) {
  const tProfile = useTranslations("profile");
  const tCommon = useTranslations("common");
  const [state, formAction, isPending] = useActionState<ProfileFormState, FormData>(
    updateProfile,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="displayName" className="mb-1 block text-sm font-medium">
          {tProfile("displayName")}
        </label>
        <input
          id="displayName"
          name="displayName"
          type="text"
          defaultValue={initial.displayName ?? ""}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="jobTitle" className="mb-1 block text-sm font-medium">
          {tProfile("jobTitle")}
        </label>
        <input
          id="jobTitle"
          name="jobTitle"
          type="text"
          defaultValue={initial.jobTitle ?? ""}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="phone" className="mb-1 block text-sm font-medium">
          {tProfile("phone")}
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          defaultValue={initial.phone ?? ""}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="officeLocation" className="mb-1 block text-sm font-medium">
          {tProfile("officeLocation")}
        </label>
        <input
          id="officeLocation"
          name="officeLocation"
          type="text"
          defaultValue={initial.officeLocation ?? ""}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="birthday" className="mb-1 block text-sm font-medium">
          {tProfile("birthday")}
        </label>
        <input
          id="birthday"
          name="birthday"
          type="date"
          defaultValue={initial.birthday ?? ""}
          className={inputClass}
        />
      </div>
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          name="birthdayVisible"
          defaultChecked={initial.birthdayVisible ?? false}
          className="mt-0.5 h-4 w-4 rounded border accent-primary"
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{tProfile("birthdayVisible")}</span>
          <span className="block text-xs text-muted-foreground">
            {tProfile("birthdayVisibleHint")}
          </span>
        </span>
      </label>

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
              defaultChecked={checked ?? false}
              className="mt-0.5 h-4 w-4 rounded border accent-primary"
            />
            <span className="block text-sm">{tProfile(name)}</span>
          </label>
        ))}
        <div className="flex gap-6 pt-1" role="radiogroup" aria-label={tProfile("digestFrequency")}>
          {(["weekly", "daily"] as const).map((freq) => (
            <label key={freq} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="digestFrequency"
                value={freq}
                defaultChecked={(initial.digestFrequency ?? "weekly") === freq}
                className="h-4 w-4 accent-primary"
              />
              {tProfile(`digestFrequency_${freq}`)}
            </label>
          ))}
        </div>
      </fieldset>

      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      {state.success && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">{state.success}</p>
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
