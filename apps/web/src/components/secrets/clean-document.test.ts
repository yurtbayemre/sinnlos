import { createElement, useEffect } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import { installFakeBrowser, type FakeBrowser } from "../live/fake-browser.test.helper";

/**
 * A secret is typed only in a document known to be free of analytics
 * (v0.35 review): the form renders its fields disabled until the client
 * has checked, and a tab that loaded Plausible while the module was off
 * (an existing tab after the switch) reloads instead of offering them.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));
vi.mock("@/lib/secret-actions", () => ({
  createSecret: async () => ({ ok: true }),
  findSecretRecipients: async () => ({ ok: true, data: [] }),
}));

const { useCleanDocument } = await import("./clean-document");
const { NewSecretForm } = await import("./new-secret-form");

describe("the new-secret form before the client check", () => {
  it("renders its fields, the text included, disabled", () => {
    const html = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
      createElement(NextIntlClientProvider, {
        locale: "en",
        messages: en,
        timeZone: "Europe/Berlin",
        children: createElement(NewSecretForm),
      }),
    );
    expect(html).toMatch(/<fieldset disabled=""[^>]*>(?:(?!<\/form>)[\s\S])*<textarea/);
  });
});

describe("useCleanDocument in the browser", () => {
  let browser: FakeBrowser;
  let clean: boolean | undefined;
  const reload = vi.fn();
  let script = false;
  const win = () => globalThis.window as unknown as Record<string, unknown>;

  function Probe() {
    const value = useCleanDocument();
    useEffect(() => {
      clean = value;
    });
    return null;
  }

  beforeEach(() => {
    browser = installFakeBrowser();
    Object.assign(win(), { location: { reload } });
    Object.assign(browser.document, {
      querySelector: (selector: string) =>
        selector === "script[data-domain]" && script ? {} : null,
    });
    clean = undefined;
    script = false;
    reload.mockClear();
  });

  afterEach(async () => {
    await browser.unmount();
    browser.uninstall();
  });

  it("is clean in a document without analytics, and reloads nothing", async () => {
    await browser.render(createElement(Probe));
    expect(clean).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads an existing tab that loaded Plausible, and never turns clean there", async () => {
    win().plausible = () => undefined;
    await browser.render(createElement(Probe));
    expect(clean).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("also reloads on the script element alone", async () => {
    script = true;
    await browser.render(createElement(Probe));
    expect(clean).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
