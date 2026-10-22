/**
 * The OIDC exchange endpoint (v0.25.0); the work is in src/oidc/provision.ts.
 * Like the Entra controller, this only:
 *   - answers 404 like a missing route while OIDC is off (OIDC_ENABLED is not
 *     '1'): no discovery or key request, nothing logged per request;
 *   - maps every unexpected error to 503 {error:'unavailable'} with one error
 *     line naming the error's code or class (errorLabel), never its message
 *     or a token.
 */
import { errorLabel, type ExchangeHost } from "../../../idp/exchange-core";
import { OidcConfigError, parseOidcConfig } from "../../../oidc/config";
import {
  OIDC_EXCHANGE_SECRET_HEADER,
  runOidcExchange,
  type OidcExchangeDeps,
} from "../../../oidc/provision";
import type { ExchangeContext } from "../../entra-auth/controllers/entra-auth";

export async function handleOidcExchange(
  ctx: ExchangeContext,
  host: ExchangeHost,
  env: Record<string, string | undefined> = process.env,
  deps: OidcExchangeDeps = {},
): Promise<void> {
  let settings;
  try {
    settings = parseOidcConfig(env);
  } catch (err) {
    // register() refuses such a boot; only an env changed at runtime lands here.
    host.log.error(
      `[oidc] exchange failed: ${err instanceof OidcConfigError ? err.message : "invalid configuration"}`,
    );
    ctx.status = 503;
    ctx.body = { error: "unavailable" };
    return;
  }
  if (!settings.enabled) {
    ctx.notFound();
    return;
  }
  try {
    const outcome = await runOidcExchange(
      host,
      settings,
      { secret: ctx.get(OIDC_EXCHANGE_SECRET_HEADER), body: ctx.request.body },
      deps,
    );
    ctx.status = outcome.status;
    ctx.body = outcome.body;
  } catch (err) {
    host.log.error(`[oidc] exchange failed (${errorLabel(err)})`);
    ctx.status = 503;
    ctx.body = { error: "unavailable" };
  }
}

export default {
  async exchange(ctx: ExchangeContext) {
    await handleOidcExchange(ctx, strapi as unknown as ExchangeHost);
  },
};
