/**
 * The boot values infra/deploy.sh checks in the candidate cms image before it
 * replaces the running stack (v0.30): APP_TIME_ZONE (config/server.ts) and
 * MFA_REQUIRED_ROLES (src/index.ts), read by the cms's own validators, so the
 * check accepts exactly what the boot accepts; and since v0.36.0 the
 * secret-sharing role lists, which the cms and the web each parse at start
 * (@sinnlos/domain parseSecretRoles) and which must be the same in both.
 * Shipped as dist/scripts/check-boot-env.js; it reads `docker compose config
 * --format json` on stdin and checks the rendered environments of the cms
 * and the web services:
 *
 *   docker compose config --format json | docker run --rm -i --network none \
 *     --entrypoint node <cms image> dist/scripts/check-boot-env.js
 *
 * Exits 1 with the parser's message for each refused value, 0 when all pass.
 */
import { readFileSync } from "node:fs";
import { parseSecretRoles } from "@sinnlos/domain";

import { parseMfaRequiredRoles } from "../src/utils/mfa-core";
import { resolveAppTimeZone } from "../src/utils/time";

const SECRET_ROLE_KEYS = ["SECRETS_SEND_ROLES", "SECRETS_RECEIVE_ROLES"] as const;

const fail = (error: unknown) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
};

try {
  const services = JSON.parse(readFileSync(0, "utf8")).services;
  // A key compose leaves without a value (null) is not set in the container.
  const reader =
    (environment: Record<string, unknown> = {}) =>
    (key: string) =>
      typeof environment[key] === "string" ? (environment[key] as string) : undefined;
  const cms = reader(services.cms.environment ?? undefined);
  // Optional: the image's own CI check feeds a cms environment alone.
  const web = reader(services.web?.environment ?? undefined);
  for (const check of [
    () => resolveAppTimeZone(cms("APP_TIME_ZONE")),
    () => parseMfaRequiredRoles(cms("MFA_REQUIRED_ROLES")),
  ]) {
    try {
      check();
    } catch (error) {
      fail(error);
    }
  }
  /** The normalized list, or null after reporting the parser's refusal. */
  const roles = (service: string, value: string | undefined, key: string) => {
    try {
      return parseSecretRoles(value, key).join(",");
    } catch (error) {
      fail(`${service}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  for (const key of SECRET_ROLE_KEYS) {
    const inCms = roles("cms", cms(key), key);
    const inWeb = roles("web", web(key), key);
    if (inCms !== null && inWeb !== null && inCms !== inWeb) {
      fail(`${key}: the cms and the web would get different lists; give both the same value`);
    }
  }
} catch (error) {
  fail(`cannot read the environments from the compose config on stdin: ${String(error)}`);
}
