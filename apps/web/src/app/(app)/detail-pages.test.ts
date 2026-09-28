import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";

/**
 * WD07: the id-addressed detail pages check the route id before any read
 * (a malformed id is a 404, never a CMS request: Postgres answers the int4
 * lookup with an error, i.e. a 500), an unknown entry is a 404, and a failed
 * read propagates to (app)/error.tsx instead of an inline banner.
 * generateMetadata never fails the page: a failed read gives the section
 * title.
 *
 * `next/navigation` is the real module (notFound's own error); the CMS
 * client, session, viewer and translations are mocked.
 */
const strapiMock = vi.fn<(path: string) => Promise<unknown>>();
const classifiedMock = vi.fn<(id: string) => Promise<unknown>>();

vi.mock("@/lib/strapi", () => ({
  strapi: (path: string) => strapiMock(path),
  api: { classifieds: { one: (id: string) => classifiedMock(id) } },
}));
vi.mock("@/lib/session", () => ({ getSession: async () => null }));
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ id: 1, displayName: "M", role: "member", department: null }),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
  getLocale: async () => "en",
}));

const person = await import("./people/[id]/page");
const ad = await import("./marketplace/[id]/page");
const adEdit = await import("./marketplace/[id]/edit/page");

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const NOT_FOUND = { digest: "NEXT_HTTP_ERROR_FALLBACK;404" };
/** Route ids Postgres would reject in an int4 lookup (or that are no id). */
const MALFORMED = ["abc", "1.5", "1e3", "0", "-1", "01", "2147483648", " 1", ""];

beforeEach(() => {
  strapiMock.mockReset();
  classifiedMock.mockReset();
});

describe("/people/[id]", () => {
  it.each(MALFORMED)("answers the malformed id %j with 404 and no CMS read", async (id) => {
    await expect(person.default(params(id))).rejects.toMatchObject(NOT_FOUND);
    await expect(person.generateMetadata(params(id))).rejects.toMatchObject(NOT_FOUND);
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("reads the canonical id and answers an unknown user (empty body or 404) with 404", async () => {
    strapiMock.mockResolvedValue(undefined);
    await expect(person.default(params("42"))).rejects.toMatchObject(NOT_FOUND);
    expect(strapiMock.mock.calls[0]![0]).toMatch(/^\/api\/users\/42\?/);
    strapiMock.mockRejectedValue(new StrapiError(404, "Not Found", ""));
    await expect(person.default(params("42"))).rejects.toMatchObject(NOT_FOUND);
  });

  it("lets a failed read reach the error boundary", async () => {
    const outage = new StrapiError(502, "Bad Gateway", "");
    strapiMock.mockRejectedValue(outage);
    await expect(person.default(params("42"))).rejects.toBe(outage);
  });

  it("titles the page with the person, or the section when the read fails", async () => {
    strapiMock.mockResolvedValue({ id: 42, displayName: "Ada Lovelace" });
    await expect(person.generateMetadata(params("42"))).resolves.toEqual({ title: "Ada Lovelace" });
    strapiMock.mockRejectedValue(new StrapiError(502, "Bad Gateway", ""));
    await expect(person.generateMetadata(params("42"))).resolves.toEqual({ title: "nav.people" });
  });
});

describe("/marketplace/[id] and /marketplace/[id]/edit", () => {
  it.each(MALFORMED)("answer the malformed id %j with 404 and no CMS read", async (id) => {
    await expect(ad.default(params(id))).rejects.toMatchObject(NOT_FOUND);
    await expect(ad.generateMetadata(params(id))).rejects.toMatchObject(NOT_FOUND);
    await expect(adEdit.default(params(id))).rejects.toMatchObject(NOT_FOUND);
    expect(classifiedMock).not.toHaveBeenCalled();
  });

  it("answer an unknown ad with 404", async () => {
    classifiedMock.mockResolvedValue({ data: [] });
    await expect(ad.default(params("7"))).rejects.toMatchObject(NOT_FOUND);
    await expect(adEdit.default(params("7"))).rejects.toMatchObject(NOT_FOUND);
    expect(classifiedMock).toHaveBeenCalledWith("7");
  });

  it("let a failed read reach the error boundary", async () => {
    const outage = new StrapiError(500, "Internal Server Error", "");
    classifiedMock.mockRejectedValue(outage);
    await expect(ad.default(params("7"))).rejects.toBe(outage);
    await expect(adEdit.default(params("7"))).rejects.toBe(outage);
  });

  it("titles the page with the ad, or the section when the read fails", async () => {
    classifiedMock.mockResolvedValue({ data: [{ id: 7, title: "Bike" }] });
    await expect(ad.generateMetadata(params("7"))).resolves.toEqual({ title: "Bike" });
    classifiedMock.mockRejectedValue(new Error("down"));
    await expect(ad.generateMetadata(params("7"))).resolves.toEqual({
      title: "marketplace.title",
    });
  });
});
