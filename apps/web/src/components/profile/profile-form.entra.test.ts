import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import de from "../../../messages/de.json";

/**
 * D-ENTRA-01 spec J: for a user bound to Microsoft Entra, GET /api/me lists
 * `entraManagedFields`, and the profile form renders those inputs read-only
 * (PUT /api/me drops them for such a user anyway). Server-rendered markup
 * with the real catalogs; the server action is stubbed.
 */
vi.mock("@/lib/profile-actions", () => ({ updateProfile: vi.fn() }));

const { ProfileForm } = await import("./profile-form");

const MANAGED = ["displayName", "jobTitle", "phone", "officeLocation"] as const;

const initial = {
  displayName: "Ada Entra",
  jobTitle: "Engineer",
  phone: "+49 30 555",
  officeLocation: "Room 1",
  birthday: "1990-02-03",
};

function render(managedFields?: readonly string[], messages: typeof en = en) {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
    createElement(NextIntlClientProvider, {
      locale: messages === en ? "en" : "de",
      messages,
      timeZone: "Europe/Berlin",
      children: createElement(ProfileForm, { initial, viewerRole: "member", managedFields }),
    }),
  );
}

/** The <input ...> tag of one field. */
const inputOf = (html: string, name: string) =>
  html.match(new RegExp(`<input[^>]*name="${name}"[^>]*/>`))?.[0] ?? "";

describe("ProfileForm with Entra-managed fields", () => {
  it("disables exactly the managed inputs, keeps their stored values and explains why", () => {
    const html = render(MANAGED);
    for (const name of MANAGED) {
      const input = inputOf(html, name);
      expect(input, name).toContain('disabled=""');
      expect(input, name).toContain('aria-describedby="entra-managed-hint"');
      expect(input, name).toContain(`value="${initial[name]}"`);
    }
    expect(inputOf(html, "birthday")).not.toContain('disabled=""');
    expect(html).toContain(en.profile.entraManagedHint);
  });

  it("leaves every input editable for a local account (no or empty list)", () => {
    for (const managed of [undefined, []]) {
      const html = render(managed);
      for (const name of MANAGED) expect(inputOf(html, name), name).not.toContain('disabled=""');
      expect(html).not.toContain(en.profile.entraManagedHint);
      expect(html).not.toContain("entra-managed-hint");
    }
  });

  it("has the hint in German too", () => {
    expect(de.profile.entraManagedHint).toBeTruthy();
    expect(render(MANAGED, de)).toContain(de.profile.entraManagedHint);
  });
});
