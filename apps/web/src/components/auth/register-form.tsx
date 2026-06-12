"use client";

import { useActionState } from "react";
import { registerLocalAccount } from "@/lib/auth-actions";

const inputClass =
  "h-10 w-full rounded-xl border bg-muted/40 px-4 text-sm outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring";

export function RegisterForm() {
  const [state, formAction, isPending] = useActionState(registerLocalAccount, {
    error: undefined,
  });

  return (
    <form action={formAction} className="space-y-3">
      <div>
        <label htmlFor="username" className="mb-1 block text-sm font-medium">
          Name
        </label>
        <input
          id="username"
          name="username"
          type="text"
          autoComplete="name"
          required
          placeholder="Jane Doe"
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="email" className="mb-1 block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@company.com"
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="password" className="mb-1 block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          className={inputClass}
        />
      </div>
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      <button
        type="submit"
        disabled={isPending}
        className="inline-flex w-full items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
      >
        {isPending ? "Creating account..." : "Create account"}
      </button>
    </form>
  );
}
