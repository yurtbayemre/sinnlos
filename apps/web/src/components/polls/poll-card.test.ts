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
 * department list is unavailable.
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
});
