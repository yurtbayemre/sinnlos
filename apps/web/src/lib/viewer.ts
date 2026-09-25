/**
 * The signed-in viewer's identity and authorization context, resolved from
 * Strapi on every request (D-SESSION-01, deep-dive
 * decisions/01-microsoft-signin.md spec M, investigations.md #1).
 *
 * Role and department used to be frozen into the Auth.js JWT at sign-in for
 * up to 7 days — and were undefined for every Microsoft user, because the
 * provider-callback payload carries neither. Every role gate now reads
 * `getViewer().role` through the fail-closed helpers in lib/roles.ts.
 *
 * Source: GET /api/me (the FX02 allowlisted self-profile, granted to every
 * role), NOT /api/users/me?populate[role]. users-permissions sanitizes the
 * populate AND the output with removeRestrictedRelations (@strapi/utils
 * sanitize/visitors/remove-restricted-relations.js), which drops `role`
 * unless the caller holds plugin::users-permissions.role.find — admin_role
 * only (apps/cms/src/index.ts CUSTOM_ACTION_GRANTS) — and guest also loses
 * `department`. Verified on a booted Strapi 5.49: /users/me returned a role
 * for admin_role only, /api/me for all seven role types.
 */
import "server-only";
import { cache } from "react";
import { unstable_rethrow } from "next/navigation";
import { DEMO_MODE } from "@/lib/config";
import { getSession } from "@/lib/session";
import { strapi } from "@/lib/strapi";

export type ViewerDepartment = { id: number; documentId: string; name: string; slug: string };

export type Viewer = {
  /** Strapi user id; null without a session or when /api/me failed. */
  id: number | null;
  displayName: string | null;
  /** Role type (e.g. "editor"); null = least privilege for every gate. */
  role: string | null;
  department: ViewerDepartment | null;
};

/** No session, or the identity could not be read: every gate denies. */
export const ANONYMOUS_VIEWER: Viewer = Object.freeze({
  id: null,
  displayName: null,
  role: null,
  department: null,
});

/**
 * DEMO_MODE has no Strapi and no session. The demo viewer is the fixture's
 * Ada Lovelace (lib/demo.ts /api/me) as a plain member — no admin UI, no
 * poll creation — which keeps the demo showing what it showed before.
 */
export const DEMO_VIEWER: Viewer = Object.freeze({
  id: 1,
  displayName: "Ada Lovelace",
  role: "member",
  department: Object.freeze({
    id: 1,
    documentId: "demo-department-1",
    name: "Engineering",
    slug: "engineering",
  }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Map the /api/me `data` object; anything unexpected becomes null. */
export function toViewer(data: unknown): Viewer {
  if (!isRecord(data) || typeof data.id !== "number") return ANONYMOUS_VIEWER;
  const role = isRecord(data.role) && typeof data.role.type === "string" ? data.role.type : null;
  const d = data.department;
  const department =
    isRecord(d) &&
    typeof d.id === "number" &&
    typeof d.documentId === "string" &&
    typeof d.name === "string" &&
    typeof d.slug === "string"
      ? { id: d.id, documentId: d.documentId, name: d.name, slug: d.slug }
      : null;
  return {
    id: data.id,
    displayName: typeof data.displayName === "string" ? data.displayName : null,
    role: role === "" ? null : role,
    department,
  };
}

/**
 * The viewer for the current request. One /api/me read per RSC render
 * (React cache(), like getSession(); the only Strapi read memoised this way,
 * see lib/session.ts). Server Actions and Route Handlers get no memo and
 * re-read on every call — that is what makes an action's gate current.
 *  - 401: strapi() redirects to /sign-in?expired=1 (NEXT_REDIRECT is
 *    rethrown here), the existing expired-session path.
 *  - any other failure: ANONYMOUS_VIEWER (role null), logged — every gate
 *    denies until the CMS answers again.
 */
export const getViewer = cache(async (): Promise<Viewer> => {
  if (DEMO_MODE) return DEMO_VIEWER;
  if (!(await getSession())) return ANONYMOUS_VIEWER;
  try {
    const res = await strapi<{ data?: unknown }>("/api/me");
    return toViewer(res?.data);
  } catch (e) {
    unstable_rethrow(e);
    console.error("[viewer] could not resolve the signed-in user (role gates deny)", e);
    return ANONYMOUS_VIEWER;
  }
});
