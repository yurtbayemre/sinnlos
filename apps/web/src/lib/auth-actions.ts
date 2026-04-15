"use server";

/**
 * Server Actions for Auth.js. Defined at module level so Next.js can
 * assign them a stable action ID — inline closures inside Server
 * Components that close over dynamically-imported symbols (like the
 * previous topbar sign-out button) don't work reliably.
 */
import { signOut } from "@/auth";

export async function signOutAction() {
  await signOut({ redirectTo: "/sign-in" });
}
