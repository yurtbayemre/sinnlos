import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";

/**
 * The profile form offers the e-mail digest opt-ins only to roles that get
 * digests (FX19): the cms skips guests in send-digests and ignores their
 * opt-ins in PUT /api/me. Fail-closed like lib/roles.ts: an unknown or
 * missing role sees no digest options either. Server-rendered markup with
 * the real English catalog; the server action is stubbed.
 */
vi.mock("@/lib/profile-actions", () => ({ updateProfile: vi.fn() }));

const { DIGEST_ROLES, ProfileForm } = await import("./profile-form");

const render = (element: ReactElement) =>
  renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
    createElement(NextIntlClientProvider, {
      locale: "en",
      messages: en,
      timeZone: "Europe/Berlin",
      children: element,
    }),
  );

const initial = {
  displayName: "Gina",
  digestAnnouncements: true,
  digestMentions: false,
  digestKudos: false,
  digestFrequency: "weekly",
};

const form = (viewerRole: string | null | undefined) =>
  render(createElement(ProfileForm, { initial, viewerRole }));

describe("ProfileForm digest options", () => {
  it("shows them to every role that gets digests", () => {
    for (const role of DIGEST_ROLES) {
      const html = form(role);
      expect(html, role).toContain("<fieldset");
      expect(html, role).toContain('name="digestAnnouncements"');
      expect(html, role).toContain(en.profile.digestSection);
    }
  });

  it("hides them from guests, unknown and missing roles", () => {
    for (const role of ["guest", "Guest", "public", "", null, undefined]) {
      const html = form(role);
      expect(html, String(role)).not.toContain("<fieldset");
      expect(html, String(role)).not.toContain('name="digest');
      expect(html, String(role)).not.toContain(en.profile.digestSection);
      // The rest of the form stays.
      expect(html, String(role)).toContain('name="displayName"');
    }
  });

  it("the digest roles are the announcement readers of the cms matrix", () => {
    expect([...DIGEST_ROLES].sort()).toEqual([
      "admin_role",
      "authenticated",
      "department_head",
      "editor",
      "member",
      "team_lead",
    ]);
  });
});
