"use client";

import { useActionState } from "react";
import { updateProfile, type ProfileFormState } from "@/lib/profile-actions";

const inputClass =
  "h-10 w-full rounded-xl border bg-muted/40 px-4 text-sm outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring";

export type ProfileInitial = {
  displayName?: string | null;
  jobTitle?: string | null;
  phone?: string | null;
  officeLocation?: string | null;
};

export function ProfileForm({ initial }: { initial: ProfileInitial }) {
  const [state, formAction, isPending] = useActionState<ProfileFormState, FormData>(
    updateProfile,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      <div>
        <label htmlFor="displayName" className="mb-1 block text-sm font-medium">
          Display name
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
          Job title
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
          Phone
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
          Office location
        </label>
        <input
          id="officeLocation"
          name="officeLocation"
          type="text"
          defaultValue={initial.officeLocation ?? ""}
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
        {isPending ? "Saving…" : "Save changes"}
      </button>
    </form>
  );
}
