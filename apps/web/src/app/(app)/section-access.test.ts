import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

/**
 * SH02 (the guest-403 fix): a page asks the CMS only for sections the
 * viewer's role can read (lib/roles.ts isReadDenied). A guest opening
 * /announcements, /departments, /teams, /kudos, /marketplace or /training
 * gets SectionUnavailable and sends no request (the CMS would answer 403:
 * an error banner and a log line); the dashboard leaves those sections out.
 * The `authenticated` fallback reads kudos but not the celebrations. A role
 * that could not be read (null) still reads: the CMS decides, and an outage
 * keeps its error banner.
 *
 * The data layer, session, viewer and translations are mocked; the pages'
 * returned element trees are searched, not rendered.
 */
const viewer = vi.hoisted(() => ({ role: "guest" as string | null }));
const calls = vi.hoisted(() => [] as string[]);

vi.mock("@/lib/strapi", () => {
  const read =
    (name: string, value: unknown = { data: [], meta: {} }) =>
    async () => {
      calls.push(name);
      return value;
    };
  return {
    api: {
      departments: { list: read("departments.list") },
      teams: { list: read("teams.list") },
      announcements: {
        list: read("announcements.list"),
        requiringAck: read("announcements.requiringAck"),
      },
      events: { upcoming: read("events.upcoming") },
      quickLinks: { list: read("quickLinks.list") },
      kudos: { list: read("kudos.list") },
      celebrations: read("celebrations"),
      classifieds: { list: read("classifieds.list"), mine: read("classifieds.mine") },
    },
  };
});
vi.mock("@/lib/training", () => ({
  fetchCourses: async () => {
    calls.push("training.courses");
    return { courses: [], truncated: false };
  },
  fetchMyProgress: async () => {
    calls.push("training.progress");
    return { completed: new Map(), truncated: false };
  },
}));
vi.mock("@/lib/acknowledgements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/acknowledgements")>()),
  fetchMyAnnouncementAcks: async () => {
    calls.push("acknowledgements.mine");
    return { acks: [], truncated: false };
  },
}));
vi.mock("@/lib/users", () => ({
  fetchAllUsers: async () => {
    calls.push("users");
    return { users: [], truncated: false };
  },
}));
vi.mock("@/lib/session", () => ({ getSession: async () => ({ user: { id: 7, name: "V" } }) }));
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ id: 7, displayName: "V", role: viewer.role, department: null }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getLocale: async () => "en",
  getFormatter: async () => ({ dateTime: () => "" }),
}));

const { SectionUnavailable } = await import("@/components/section-unavailable");
const { AckBanner } = await import("@/components/dashboard/ack-banner");
const { TrainingBanner } = await import("@/components/training/training-banner");
const { LatestNews } = await import("@/components/dashboard/latest-news");

const pages = {
  announcements: (await import("./announcements/page")).default,
  departments: (await import("./departments/page")).default,
  teams: (await import("./teams/page")).default,
  kudos: (await import("./kudos/page")).default,
  training: (await import("./training/page")).default,
  marketplace: () =>
    import("./marketplace/page").then((page) =>
      page.default({ searchParams: Promise.resolve({}) }),
    ),
};
const dashboard = (await import("./page")).default;

/** Every element in a returned page tree (through children). */
function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}

const has = (tree: ReturnType<typeof elements>, type: unknown) =>
  tree.some((element) => element.type === type);

beforeEach(() => {
  calls.length = 0;
  viewer.role = "guest";
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("section pages", () => {
  it.each(Object.entries(pages))(
    "%s: a guest gets the explanation and no CMS request",
    async (_name, page) => {
      const tree = elements(await page());
      expect(has(tree, SectionUnavailable)).toBe(true);
      expect(calls).toEqual([]);
    },
  );

  it.each(Object.entries(pages))("%s: a member reads the section", async (_name, page) => {
    viewer.role = "member";
    const tree = elements(await page());
    expect(has(tree, SectionUnavailable)).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
  });

  it.each(Object.entries(pages))(
    "%s: an unreadable role still reads (the CMS decides)",
    async (_name, page) => {
      viewer.role = null;
      const tree = elements(await page());
      expect(has(tree, SectionUnavailable)).toBe(false);
      expect(calls.length).toBeGreaterThan(0);
    },
  );

  it("kudos: the `authenticated` fallback reads kudos but not the celebrations", async () => {
    viewer.role = "authenticated";
    const tree = elements(await pages.kudos());
    expect(has(tree, SectionUnavailable)).toBe(false);
    expect(calls).toContain("kudos.list");
    expect(calls).not.toContain("celebrations");
    viewer.role = "member";
    calls.length = 0;
    await pages.kudos();
    expect(calls).toContain("celebrations");
  });
});

describe("dashboard", () => {
  it("a guest's dashboard neither asks for nor shows the sections it cannot read", async () => {
    const tree = elements(await dashboard());
    expect(calls.sort()).toEqual(["events.upcoming", "quickLinks.list"]);
    expect(has(tree, AckBanner)).toBe(false);
    expect(has(tree, TrainingBanner)).toBe(false);
    expect(has(tree, LatestNews)).toBe(false);
    const links = tree.map((element) => element.props.href).filter(Boolean);
    for (const href of ["/departments", "/teams", "/announcements", "/kudos"]) {
      expect(links, href).not.toContain(href);
    }
    for (const href of ["/events", "/wiki"]) expect(links, href).toContain(href);
  });

  it.each(["member", null])("%s: the dashboard shows every section", async (role) => {
    viewer.role = role;
    const tree = elements(await dashboard());
    expect(calls.sort()).toEqual([
      "announcements.list",
      "departments.list",
      "events.upcoming",
      "quickLinks.list",
      "teams.list",
    ]);
    expect(has(tree, AckBanner)).toBe(true);
    expect(has(tree, TrainingBanner)).toBe(true);
    expect(has(tree, LatestNews)).toBe(true);
    const links = tree.map((element) => element.props.href).filter(Boolean);
    for (const href of ["/departments", "/teams", "/announcements", "/kudos", "/events", "/wiki"]) {
      expect(links, href).toContain(href);
    }
  });
});

describe("SectionUnavailable", () => {
  it.each([
    ["en", en],
    ["de", de],
  ] as const)("explains in %s and links back to the dashboard", (locale, messages) => {
    const html = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
      createElement(NextIntlClientProvider, {
        locale,
        messages,
        timeZone: "Europe/Berlin",
        children: createElement(SectionUnavailable),
      }),
    );
    expect(html).toContain(messages.errors.sectionUnavailableTitle);
    expect(html).toContain(messages.errors.sectionUnavailableHint);
    expect(html).toContain(`href="/"`);
    expect(html).toContain(messages.errors.backToDashboard);
  });
});
