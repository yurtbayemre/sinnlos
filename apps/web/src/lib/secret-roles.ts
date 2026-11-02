/**
 * Who may send and who may receive secrets in the web (v0.36.0,
 * docs/plan-secret-sharing-by-role.md §2.3): SECRETS_SEND_ROLES and
 * SECRETS_RECEIVE_ROLES, the same values and the same parser as the cms
 * (@sinnlos/domain secretRoles). Unset or empty, both are all staff.
 *
 * The cms decides every request (create, recipient search and reveal answer
 * 403 outside the lists); the web only hides the controls. The read gate
 * SECRET_SHARE_ROLES (lib/roles.ts) stays: every staff member keeps
 * /secrets with their sent list and revoke.
 *
 * Read per call like lib/switches.ts and checked once at the start
 * (instrumentation.ts): a bad value refuses the start like the cms boot.
 * Server only: client components never see these env values.
 */
import { secretRoles, secretRolesAllow } from "@sinnlos/domain";

/** Fail-closed and exact like the role gates: null or an unknown role sends nothing. */
export function canSendSecrets(role: string | null | undefined): boolean {
  return secretRolesAllow(secretRoles(process.env).send, role);
}

/** Fail-closed and exact: null or an unknown role receives nothing. */
export function canReceiveSecrets(role: string | null | undefined): boolean {
  return secretRolesAllow(secretRoles(process.env).receive, role);
}
