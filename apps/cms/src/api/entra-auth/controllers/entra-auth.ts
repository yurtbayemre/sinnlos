/**
 * The Entra exchange endpoint (D-ENTRA-01 spec D); the work is in
 * src/entra/provision.ts. This controller only:
 *   - answers 404 like a missing route while Entra is off (ENTRA_ENABLED is
 *     not '1'): no JWKS or Graph traffic, nothing logged per request;
 *   - maps every unexpected error to 503 {error:'unavailable'} with one
 *     error line: the error's code or class name (errorLabel), never its
 *     message, which for a failed query carries the SQL and the profile
 *     values bound to it; never a token.
 */
import { EntraConfigError, parseEntraConfig } from "../../../entra/config";
import {
  EXCHANGE_SECRET_HEADER,
  errorLabel,
  runEntraExchange,
  type ExchangeDeps,
  type ExchangeHost,
} from "../../../entra/provision";

/** The slice of the Koa context the handler uses. */
export interface ExchangeContext {
  get(field: string): string;
  request: { body?: unknown };
  status: number;
  body: unknown;
  notFound(): unknown;
}

/**
 * The handler, with its collaborators passed in (the route uses the global
 * `strapi` and the process env).
 */
export async function handleExchange(
  ctx: ExchangeContext,
  host: ExchangeHost,
  env: Record<string, string | undefined> = process.env,
  deps: ExchangeDeps = {},
): Promise<void> {
  let settings;
  try {
    settings = parseEntraConfig(env);
  } catch (err) {
    // register() refuses such a boot; only an env changed at runtime lands here.
    host.log.error(
      `[entra] exchange failed: ${err instanceof EntraConfigError ? err.message : "invalid configuration"}`,
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
    const outcome = await runEntraExchange(
      host,
      settings,
      { secret: ctx.get(EXCHANGE_SECRET_HEADER), body: ctx.request.body },
      deps,
    );
    ctx.status = outcome.status;
    ctx.body = outcome.body;
  } catch (err) {
    host.log.error(`[entra] exchange failed (${errorLabel(err)})`);
    ctx.status = 503;
    ctx.body = { error: "unavailable" };
  }
}

export default {
  async exchange(ctx: ExchangeContext) {
    await handleExchange(ctx, strapi as unknown as ExchangeHost);
  },
};
