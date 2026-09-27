import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import type { PollResults } from "@/lib/types";

/**
 * Server-rendered markup of the poll card and form (decision 02): an admin
 * or editor outside a targeted poll's departments sees the results with
 * disabled buttons and the notInAudience hint, a targeted poll without a
 * department left says so, and the create form refuses to submit while the
 * department list is unavailable. Guest access (owner decision 2026-09-27):
 * a guest who may not vote sees guestVotingDisabled, admins and editors see
 * which guest access a poll has, and the form offers both switches off.
 *
 * The server action module and the router are stubbed; next-intl renders
 * the real English catalog.
 */
vi.mock("@/lib/poll-actions", () => ({ votePoll: vi.fn(), createPoll: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const { PollCard } = await import("./poll-card");
const { PollForm } = await import("./poll-form");

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

const results = (overrides: Partial<PollResults>): PollResults => ({
  poll: { id: 4, question: "Which on-call tool?", options: ["Pager", "Chat"], closesAt: null, anonymous: false },
  counts: [3, 1],
  total: 4,
  myVoteIndex: null,
  canVote: true,
  audience: { targeted: false, departments: [] },
  ...overrides,
});

/** The option buttons of the rendered card. */
const optionButtons = (html: string) => html.match(/<button[^>]*type="button"[^>]*>/g) ?? [];

/** The boolean `disabled` attribute (not the `disabled:` Tailwind variant in the class). */
const isDisabled = (tag: string) => /\sdisabled=""/.test(tag);

describe("PollCard", () => {
  it("offers enabled vote buttons and no results to a member who has not voted", () => {
    const html = render(createElement(PollCard, { results: results({}) }));
    const buttons = optionButtons(html);
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(isDisabled(button)).toBe(false);
    expect(html).not.toContain("75%");
  });

  it("shows results, disabled buttons and the notInAudience hint when canVote is false", () => {
    const html = render(
      createElement(PollCard, {
        results: results({
          canVote: false,
          audience: { targeted: true, departments: [{ documentId: "d-eng", name: "Engineering" }] },
        }),
      }),
    );
    for (const button of optionButtons(html)) expect(isDisabled(button)).toBe(true);
    expect(html).toContain("75%");
    expect(html).toContain(en.polls.notInAudience);
    expect(html).toContain("Only for: Engineering");
  });

  it("shows the audienceMissing hint for a targeted poll without departments", () => {
    const html = render(
      createElement(PollCard, {
        results: results({ canVote: false, audience: { targeted: true, departments: [] } }),
      }),
    );
    expect(html).toContain(en.polls.audienceMissing);
    expect(html).not.toContain(en.polls.notInAudience);
    expect(html).not.toContain("Only for:");
  });

  it("keeps the vote buttons when the CMS sends no canVote (older CMS)", () => {
    const html = render(
      createElement(PollCard, { results: results({ canVote: undefined, audience: undefined }) }),
    );
    for (const button of optionButtons(html)) expect(isDisabled(button)).toBe(false);
  });
});

describe("PollCard: guest access (owner decision 2026-09-27)", () => {
  /** How react-dom/server writes the copy (the apostrophe is escaped). */
  const GUEST_VOTING_DISABLED = en.polls.guestVotingDisabled.replace(/'/g, "&#x27;");

  const visible = (guestsCanVote: boolean, canVote: boolean) =>
    results({
      poll: {
        id: 6,
        question: "Office party theme?",
        options: ["Pager", "Chat"],
        closesAt: null,
        anonymous: false,
        visibleToGuests: true,
        guestsCanVote,
      },
      canVote,
    });

  it("shows a guest the results, disabled buttons and guestVotingDisabled on a poll without guest voting", () => {
    const html = render(createElement(PollCard, { results: visible(false, false), viewerRole: "guest" }));
    for (const button of optionButtons(html)) expect(isDisabled(button)).toBe(true);
    expect(html).toContain("75%");
    expect(html).toContain(GUEST_VOTING_DISABLED);
    expect(html).not.toContain(en.polls.notInAudience);
  });

  it("lets a guest vote where the CMS says so, without a hint", () => {
    const html = render(createElement(PollCard, { results: visible(true, true), viewerRole: "guest" }));
    for (const button of optionButtons(html)) expect(isDisabled(button)).toBe(false);
    expect(html).not.toContain(GUEST_VOTING_DISABLED);
  });

  it("gives no guest-access notes to a guest or a member", () => {
    for (const viewerRole of ["guest", "member", "department_head", null]) {
      const html = render(createElement(PollCard, { results: visible(true, true), viewerRole }));
      expect(html, String(viewerRole)).not.toContain(en.polls.guestAccessVisible);
      expect(html, String(viewerRole)).not.toContain(en.polls.guestAccessVote);
    }
  });

  it("notes the guest access to admins and editors", () => {
    for (const viewerRole of ["admin_role", "editor"]) {
      const both = render(createElement(PollCard, { results: visible(true, true), viewerRole }));
      expect(both, viewerRole).toContain(en.polls.guestAccessVisible);
      expect(both, viewerRole).toContain(en.polls.guestAccessVote);

      const readOnly = render(createElement(PollCard, { results: visible(false, true), viewerRole }));
      expect(readOnly, viewerRole).toContain(en.polls.guestAccessVisible);
      expect(readOnly, viewerRole).not.toContain(en.polls.guestAccessVote);

      const hidden = render(createElement(PollCard, { results: results({}), viewerRole }));
      expect(hidden, viewerRole).not.toContain(en.polls.guestAccessVisible);
    }
  });

  it("keeps notInAudience for an admin or editor outside the departments", () => {
    const html = render(
      createElement(PollCard, {
        results: results({
          canVote: false,
          audience: { targeted: true, departments: [{ documentId: "d-eng", name: "Engineering" }] },
        }),
        viewerRole: "editor",
      }),
    );
    expect(html).toContain(en.polls.notInAudience);
    expect(html).not.toContain(GUEST_VOTING_DISABLED);
  });
});

describe("PollForm", () => {
  const departments = [{ id: 1, name: "Engineering" }];
  const submitButton = (html: string) => html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? "";

  it("disables submit and says why when the departments could not be loaded", () => {
    const html = render(createElement(PollForm, { departments: [], departmentsUnavailable: true }));
    expect(isDisabled(submitButton(html))).toBe(true);
    expect(html).toContain(en.polls.departmentsUnavailable);
  });

  it("offers the department picker with the restriction copy otherwise", () => {
    const html = render(createElement(PollForm, { departments }));
    expect(isDisabled(submitButton(html))).toBe(false);
    expect(html).toContain(en.polls.formDepartments);
    expect(html).toContain(en.polls.formDepartmentsHint);
    expect(html).not.toContain(en.polls.departmentsUnavailable);
  });

  /** The <input> tag with the given id. */
  const inputById = (html: string, id: string) => html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? "";
  const isChecked = (tag: string) => /\schecked=""/.test(tag);

  it("offers both guest switches unchecked, the vote switch disabled until the poll is visible to guests", () => {
    for (const props of [{ departments }, { departments: [] }]) {
      const html = render(createElement(PollForm, props));
      const visible = inputById(html, "poll-visible-to-guests");
      const vote = inputById(html, "poll-guests-can-vote");
      expect(visible).toContain('type="checkbox"');
      expect(vote).toContain('type="checkbox"');
      expect(isChecked(visible)).toBe(false);
      expect(isChecked(vote)).toBe(false);
      expect(isDisabled(visible)).toBe(false);
      expect(isDisabled(vote)).toBe(true);
      expect(html).toContain(en.polls.formGuestAccess);
      expect(html).toContain(en.polls.formGuestAccessHint);
      expect(html).toContain(en.polls.formVisibleToGuests);
      expect(html).toContain(en.polls.formGuestsCanVote);
    }
  });
});
