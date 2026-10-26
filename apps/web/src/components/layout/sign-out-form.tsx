"use client";

import type { ReactNode } from "react";
import { confirmLeave } from "@/components/manage/unsaved-guard";
import { signOutAction } from "@/lib/auth-actions";

/**
 * The sign-out form (v0.30). An editor with unsaved changes asks first: the
 * submit handler runs before React calls the Server Action, so Cancel keeps
 * both the session and the form's text.
 */
export function SignOutForm({ children }: { children: ReactNode }) {
  return (
    <form
      action={signOutAction}
      onSubmit={(event) => {
        if (!confirmLeave()) event.preventDefault();
      }}
    >
      {children}
    </form>
  );
}
