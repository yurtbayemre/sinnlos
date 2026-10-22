/**
 * The fetch Auth.js uses for the OIDC provider (v0.25.0, Codex round 1).
 * @auth/core allows plain http on this path (allowInsecureRequests) and
 * sends the client secret to the token endpoint, and the browser types the
 * password at the authorization endpoint the discovery document names. So:
 *   - every request of the provider must be https (OIDC_ALLOW_HTTP=1 allows
 *     http: development and staging only);
 *   - the discovery document must not name an http endpoint, checked before
 *     Auth.js redirects to it or posts the code and the secret to it.
 * A refusal throws, which Auth.js answers with its error page (/sign-in).
 */
const ENDPOINT_FIELDS = [
  "authorization_endpoint",
  "token_endpoint",
  "userinfo_endpoint",
  "jwks_uri",
];

export function oidcFetch(allowHttp: boolean, fetchImpl: typeof fetch = fetch): typeof fetch {
  const allowed = (value: unknown) => {
    try {
      const { protocol } = new URL(String(value));
      return protocol === "https:" || (allowHttp && protocol === "http:");
    } catch {
      return false;
    }
  };
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!allowed(url)) {
      throw new TypeError(
        "[auth] OIDC request refused: https only (OIDC_ALLOW_HTTP=1 allows http)",
      );
    }
    const response = await fetchImpl(input, init);
    if (response.ok && new URL(url).pathname.endsWith("/.well-known/openid-configuration")) {
      const document: unknown = await response
        .clone()
        .json()
        .catch(() => null);
      for (const field of ENDPOINT_FIELDS) {
        const value =
          typeof document === "object" && document !== null
            ? (document as Record<string, unknown>)[field]
            : undefined;
        if (value !== undefined && !allowed(value)) {
          throw new TypeError(
            `[auth] OIDC discovery refused: ${field} is not https (OIDC_ALLOW_HTTP=1 allows http)`,
          );
        }
      }
    }
    return response;
  };
}
