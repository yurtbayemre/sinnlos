import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../../messages/en.json";

/**
 * v0.34 (A-02): when the cms did not confirm that a sign-out ended the
 * account's other sessions, the FIRST /sign-in render after it says so,
 * also after Microsoft's end-session round trip: the action's notice cookie
 * (path /sign-in, SameSite=Lax) is what the browser sends back on the
 * top-level return to the registered post-logout URI. A confirmed sign-out
 * deletes it, and the page says nothing. The browser's cookie jar is
 * simulated: what the action sets is what the page reads.
 */
const TENANT = "11111111-2222-4333-8444-555555555555";

const state = vi.hoisted(() => ({
  signedIn: true,
  jar: new Map<string, { value: string; options?: Record<string, unknown> }>(),
  cms: (): Promise<Response> => Promise.resolve(new Response(null, { status: 204 })),
  redirects: [] as string[],
}));

vi.mock("@/auth", () => ({
  signIn: vi.fn(),
  signOut: async () => {
    state.signedIn = false;
  },
}));
vi.mock("@/lib/session", () => ({
  getSession: async () =>
    state.signedIn ? { provider: "microsoft-entra-id", user: { id: 1 } } : null,
  getStrapiToken: async () => (state.signedIn ? "session.jwt" : null),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "intranet.example.test" }),
  cookies: async () => ({
    get: (name: string) => {
      const entry = state.jar.get(name);
      return entry ? { name, value: entry.value } : undefined;
    },
    set: (name: string, value: string, options: Record<string, unknown>) =>
      state.jar.set(name, { value, options }),
    delete: (options: { name: string }) => state.jar.delete(options.name),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    state.redirects.push(url);
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url}` });
  },
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: keyof typeof en) => (key: string) =>
    (en[namespace] as Record<string, string>)[key] ?? key,
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as never),
}));
vi.mock("@/components/auth/local-sign-in-form", () => ({
  LocalSignInForm: () => createElement("form", { id: "local" }),
}));
vi.mock("@/components/layout/site-footer", () => ({
  SiteFooter: () => createElement("footer"),
}));
vi.stubGlobal(
  "fetch",
  vi.fn(async () => state.cms()),
);

const ENTRA_ENV = {
  ENTRA_ENABLED: "1",
  AUTH_LOCAL_ENABLED: "1",
  AUTH_MICROSOFT_ENTRA_ID_TENANT_ID: TENANT,
  AUTH_MICROSOFT_ENTRA_ID_ID: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  AUTH_MICROSOFT_ENTRA_ID_SECRET: "client-secret-value",
  ENTRA_EXCHANGE_SECRET: "0123456789abcdef0123456789abcdef",
  AUTH_URL: "https://intranet.example.test",
};

async function modules() {
  vi.resetModules();
  for (const [key, value] of Object.entries(ENTRA_ENV)) vi.stubEnv(key, value);
  const { signOutAction } = await import("@/lib/auth-actions");
  const { default: SignInPage } = await import("./page");
  return { signOutAction, SignInPage };
}

/** Signs out (the action ends in a redirect) and returns where it sent the browser. */
async function signOut(signOutAction: () => Promise<void>) {
  state.signedIn = true;
  await expect(signOutAction()).rejects.toThrow("NEXT_REDIRECT");
  return new URL(state.redirects.at(-1) ?? "about:blank");
}

async function renderSignIn(SignInPage: (props: never) => Promise<unknown>) {
  const page = await SignInPage({ searchParams: Promise.resolve({}) } as never);
  return renderToStaticMarkup(page as never);
}

beforeEach(() => {
  state.jar.clear();
  state.redirects = [];
  state.cms = () => Promise.resolve(new Response(null, { status: 204 }));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/sign-in after a sign-out (v0.34)", () => {
  it("says on the first return from Microsoft that the other sessions were not confirmed ended", async () => {
    const { signOutAction, SignInPage } = await modules();
    state.cms = () => Promise.resolve(new Response("down", { status: 503 }));
    const endSession = await signOut(signOutAction);
    expect(`${endSession.origin}${endSession.pathname}`).toBe(
      `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
    );
    // Microsoft sends the browser back here, top-level: the Lax cookie for
    // /sign-in goes with that request.
    const back = new URL(endSession.searchParams.get("post_logout_redirect_uri") ?? "");
    const notice = state.jar.get("sinnlos-sign-out-unconfirmed");
    expect(notice?.options).toMatchObject({ path: back.pathname, sameSite: "lax", secure: true });
    expect(await renderSignIn(SignInPage)).toContain(en.auth.signedOutUnconfirmed);
  });

  it("says nothing after a confirmed sign-out, also when an older notice was still there", async () => {
    const { signOutAction, SignInPage } = await modules();
    state.cms = () => Promise.resolve(new Response("down", { status: 503 }));
    await signOut(signOutAction);
    state.cms = () => Promise.resolve(new Response(null, { status: 204 }));
    await signOut(signOutAction);
    expect(state.jar.has("sinnlos-sign-out-unconfirmed")).toBe(false);
    expect(await renderSignIn(SignInPage)).not.toContain(en.auth.signedOutUnconfirmed);
  });
});
