/**
 * The boot values infra/deploy.sh checks in the candidate cms image before it
 * replaces the running stack (v0.30): APP_TIME_ZONE (config/server.ts) and
 * MFA_REQUIRED_ROLES (src/index.ts), read by the cms's own validators, so the
 * check accepts exactly what the boot accepts. Shipped as
 * dist/scripts/check-boot-env.js; run from apps/cms:
 *
 *   node dist/scripts/check-boot-env.js
 *
 * Exits 1 with the cms's message for each refused value, 0 when both pass.
 */
import { parseMfaRequiredRoles } from "../src/utils/mfa-core";
import { resolveAppTimeZone } from "../src/utils/time";

const checks = [
  () => resolveAppTimeZone(process.env.APP_TIME_ZONE),
  () => parseMfaRequiredRoles(process.env.MFA_REQUIRED_ROLES),
];

for (const check of checks) {
  try {
    check();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
