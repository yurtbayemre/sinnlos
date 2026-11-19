import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../../../messages/en.json";
import { DepartmentChart } from "@/components/people/department-chart";
import { FetchErrorBanner } from "@/components/fetch-error";
import { StrapiError } from "@/lib/strapi-error";

/**
 * The org chart page (v1.1): the reporting-line chart is the default and stays
 * as it was; `?view=departments` is the department → head → teams → lead →
 * member count view. The view switch is two links with `aria-current`. The
 * guest gate (no request at all) is pinned in section-access.test.ts.
 */
const who = vi.hoisted(() => ({ role: "member" as string | null }));
const departmentsMock = vi.fn<() => Promise<unknown>>();
const teamsMock = vi.fn<() => Promise<unknown>>();

vi.mock("@/lib/strapi", () => ({
  api: { departments: { list: () => departmentsMock() }, teams: { list: () => teamsMock() } },
}));
vi.mock("@/lib/users", () => ({ fetchAllUsers: async () => ({ users: [], truncated: false }) }));
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ id: 7, displayName: "V", role: who.role, department: null }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: "people") => (key: string) =>
    (en[namespace] as Record<string, string>)[key] ?? key,
}));

const page = await import("./page");

const ada = { id: 7, displayName: "Ada Lovelace", jobTitle: null };
const engineering = { id: 1, name: "Engineering", slug: "engineering", head: ada };
const platform = {
  id: 10,
  name: "Platform",
  slug: "platform",
  department: { id: 1 },
  lead: ada,
  members: [ada, { id: 8, displayName: "Bob" }],
};

function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}

const view = (query: { view?: string }) => page.default({ searchParams: Promise.resolve(query) });

/** The page as HTML. The failure banner is an async component and is checked in the tree instead. */
async function html(query: { view?: string }) {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
    createElement(NextIntlClientProvider, {
      locale: "en",
      messages: en,
      timeZone: "Europe/Berlin",
      children: await view(query),
    }),
  );
}

beforeEach(() => {
  who.role = "member";
  departmentsMock.mockReset().mockResolvedValue({ data: [engineering], truncated: false });
  teamsMock.mockReset().mockResolvedValue({ data: [platform], truncated: false });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/people/org-chart", () => {
  it("shows the department view as nested lists with head, lead and member count", async () => {
    const out = await html({ view: "departments" });
    expect(out).toMatch(
      /<h2[^>]*><a [^>]*href="\/departments\/engineering"[^>]*>Engineering<\/a><\/h2>/,
    );
    expect(out).toMatch(/<h3[^>]*><a [^>]*href="\/teams\/platform"[^>]*>Platform<\/a><\/h3>/);
    expect(out).toMatch(/Head:\s*(<!-- -->)?\s*<a [^>]*href="\/people\/7"[^>]*>Ada Lovelace<\/a>/);
    expect(out).toContain("Team lead:");
    expect(out).toContain("2 members");
    // A list inside a list item of a list.
    expect(out).toMatch(/<ul[^>]*><li><div[\s\S]*<\/div><ul[^>]*><li>/);
    expect(departmentsMock).toHaveBeenCalledTimes(1);
    expect(teamsMock).toHaveBeenCalledTimes(1);
  });

  it("marks the current view in the switch, in both views", async () => {
    const departments = await html({ view: "departments" });
    expect(departments).toMatch(
      /<a [^>]*aria-current="page"[^>]*href="\/people\/org-chart\?view=departments"/,
    );
    expect(departments).not.toMatch(/aria-current="page"[^>]*href="\/people\/org-chart"/);

    departmentsMock.mockClear();
    teamsMock.mockClear();
    const reporting = await html({});
    expect(reporting).toMatch(/<a [^>]*aria-current="page"[^>]*href="\/people\/org-chart"/);
    expect(reporting).not.toMatch(
      /aria-current="page"[^>]*href="\/people\/org-chart\?view=departments"/,
    );
    // The default view asks for neither departments nor teams.
    expect(departmentsMock).not.toHaveBeenCalled();
    expect(teamsMock).not.toHaveBeenCalled();
  });

  it("says so when a list was truncated, and still shows what was loaded", async () => {
    teamsMock.mockResolvedValue({ data: [platform], truncated: true });
    const out = await html({ view: "departments" });
    expect(out).toContain(en.people.deptTruncated);
    expect(out).toContain("Engineering");
    expect(await html({ view: "departments" })).toMatch(/role="status"/);
  });

  it("shows no truncation notice for a complete list", async () => {
    expect(await html({ view: "departments" })).not.toContain(en.people.deptTruncated);
  });

  it("an empty organisation gets the empty state, not an empty list", async () => {
    departmentsMock.mockResolvedValue({ data: [], truncated: false });
    teamsMock.mockResolvedValue({ data: [], truncated: false });
    const out = await html({ view: "departments" });
    expect(out).toContain(en.people.deptEmptyTitle);
    expect(out).not.toContain("<ul");
  });

  it("lists a team without a department under its own heading", async () => {
    teamsMock.mockResolvedValue({
      data: [{ ...platform, department: null, lead: null, members: undefined }],
      truncated: false,
    });
    const out = await html({ view: "departments" });
    expect(out).toContain(en.people.deptUnassigned);
    expect(out).toContain(en.people.deptNoLead);
    expect(out).toContain("0 members");
    expect(out).toContain(en.people.deptNoTeams);
  });

  it.each([
    [
      "departments",
      () => departmentsMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", "")),
    ],
    ["teams", () => teamsMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""))],
  ])("an outage of the %s read shows the banner alone, never half a chart", async (_name, fail) => {
    fail();
    const tree = elements(await view({ view: "departments" }));
    expect(tree.some((element) => element.type === FetchErrorBanner)).toBe(true);
    expect(tree.some((element) => element.type === DepartmentChart)).toBe(false);
  });
});
