/**
 * The boot values infra/deploy.sh checks in the candidate cms image before it
 * replaces the running stack (v0.30): APP_TIME_ZONE (config/server.ts) and
 * MFA_REQUIRED_ROLES (src/index.ts), read by the cms's own validators, so the
 * check accepts exactly what the boot accepts. Shipped as
 * dist/scripts/check-boot-env.js; it reads `docker compose config --format
 * json` on stdin and checks the cms service's rendered environment:
 *
 *   docker compose config --format json | docker run --rm -i --network none \
 *     --entrypoint node <cms image> dist/scripts/check-boot-env.js
 *
 * Exits 1 with the cms's message for each refused value, 0 when both pass.
 */
import { readFileSync } from "node:fs";

import { parseMfaRequiredRoles } from "../src/utils/mfa-core";
import { resolveAppTimeZone } from "../src/utils/time";

const fail = (error: unknown) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
};

try {
  const environment = JSON.parse(readFileSync(0, "utf8")).services.cms.environment ?? {};
  // A key compose leaves without a value (null) is not set in the container.
  const value = (key: string) =>
    typeof environment[key] === "string" ? (environment[key] as string) : undefined;
  for (const check of [
    () => resolveAppTimeZone(value("APP_TIME_ZONE")),
    () => parseMfaRequiredRoles(value("MFA_REQUIRED_ROLES")),
  ]) {
    try {
      check();
    } catch (error) {
      fail(error);
    }
  }
} catch (error) {
  fail(`cannot read the cms environment from the compose config on stdin: ${String(error)}`);
}
