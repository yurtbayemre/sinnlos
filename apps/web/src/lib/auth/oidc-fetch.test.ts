import { describe, expect, it, vi } from "vitest";
import { oidcFetch } from "./oidc-fetch";

/** The OIDC provider's fetch: https only, and no http endpoint in the discovery document. */
const DISCOVERY = "https://idp.example/realms/x/.well-known/openid-configuration";
const document = (overrides: Record<string, unknown> = {}) => ({
  issuer: "https://idp.example/realms/x",
  authorization_endpoint: "https://idp.example/realms/x/auth",
  token_endpoint: "https://idp.example/realms/x/token",
  userinfo_endpoint: "https://idp.example/realms/x/userinfo",
  jwks_uri: "https://idp.example/realms/x/certs",
  ...overrides,
});

describe("oidcFetch", () => {
  it("refuses an http request unless OIDC_ALLOW_HTTP=1, before any network", async () => {
    const network = vi.fn(async () => Response.json({}));
    await expect(
      oidcFetch(false, network)("http://idp.example/token", { method: "POST" }),
    ).rejects.toThrow(/https only/);
    expect(network).not.toHaveBeenCalled();
    await expect(oidcFetch(true, network)("http://idp.example/token")).resolves.toBeInstanceOf(
      Response,
    );
  });

  it("refuses a discovery document that names an http endpoint", async () => {
    for (const field of [
      "authorization_endpoint",
      "token_endpoint",
      "userinfo_endpoint",
      "jwks_uri",
    ]) {
      const network = vi.fn(async () =>
        Response.json(document({ [field]: "http://idp.example/x" })),
      );
      await expect(oidcFetch(false, network)(DISCOVERY), field).rejects.toThrow(field);
      await expect(oidcFetch(true, network)(DISCOVERY), field).resolves.toBeInstanceOf(Response);
    }
  });

  it("passes an https document through, still readable by Auth.js", async () => {
    const network = vi.fn(async () => Response.json(document()));
    const response = await oidcFetch(false, network)(DISCOVERY);
    expect(await response.json()).toEqual(document());
  });
});
