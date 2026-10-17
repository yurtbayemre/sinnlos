import { beforeEach, expect, it, vi } from "vitest";
import { fetchActivity } from "@/lib/api/manage/activity";
import { activityHref, activityQuery, loadActivity, parseActivityFilters } from "./activity";

const strapiMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/strapi/client", () => ({ strapi: strapiMock }));
const page = { data: [], meta: { pagination: { page: 2, pageSize: 25, pageCount: 4, total: 79 } } };
const zone = "Europe/Berlin";
beforeEach(() => {
  strapiMock.mockReset().mockResolvedValue(page);
});

it("sends only the seven custom query keys, never generic Strapi options", async () => {
  await fetchActivity({
    page: 2,
    actorKind: "admin",
    actorId: 7,
    actorClass: "moderator",
    targetUid: "api::course.course",
    from: "2026-10-17T00:00:00Z",
    to: "2026-10-18T00:00:00Z",
    populate: "*",
  } as Parameters<typeof fetchActivity>[0]);
  const url = new URL(strapiMock.mock.calls[0][0], "https://example.test");
  expect(url.pathname).toBe("/api/audit-events");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    page: "2",
    actorKind: "admin",
    actorId: "7",
    actorClass: "moderator",
    targetUid: "api::course.course",
    from: "2026-10-17T00:00:00Z",
    to: "2026-10-18T00:00:00Z",
  });
  expect(strapiMock.mock.calls[0]).toHaveLength(1);
});

it("converts wall-time bounds in the deployment zone, not the browser or process zone", () => {
  expect(
    activityQuery(
      parseActivityFilters({
        fromDate: "2026-10-17",
        fromTime: "08:30",
        toDate: "2026-10-17",
        toTime: "09:00",
        actorKind: "user",
        actorId: "7",
      }),
      zone,
    ),
  ).toEqual({
    page: 1,
    from: "2026-10-17T06:30:00.000Z",
    to: "2026-10-17T07:00:00.000Z",
    actorKind: "user",
    actorId: 7,
  });
});

it.each(["0", "10001", "1.5", "x"])("bounds a malformed page %s", (page) => {
  expect(parseActivityFilters({ page }).page).toBe(1);
});
it("retains a valid bounded page", () => {
  expect(parseActivityFilters({ page: "10000" }).page).toBe(10000);
});

it.each([
  { actorKind: "root" },
  { actorClass: "root" },
  { targetUid: "admin::user" },
  { actorId: "7" },
  { actorKind: "system", actorId: "7" },
  { actorKind: "user", actorId: "0" },
  { actorKind: "user", actorId: "2147483648" },
  { actorKind: "admin", actorId: "7.5" },
  { actorKind: "user", actorId: "7e1" },
  { fromDate: "2026-10-17" },
  { toTime: "13:00" },
  { fromDate: "2026-02-30", fromTime: "12:00" },
  { fromDate: "2026-03-29", fromTime: "02:30" },
  { toDate: "2026-10-25", toTime: "02:30" },
  { fromDate: "2026-10-18", fromTime: "12:00", toDate: "2026-10-17", toTime: "12:00" },
])("rejects invalid filters without a CMS request: %j", async (params) => {
  const result = await loadActivity(parseActivityFilters(params), zone);
  expect(result).toMatchObject({ invalid: true, failed: false, empty: false, rows: [] });
  expect(strapiMock).not.toHaveBeenCalled();
});

it("ignores unknown and array-valued URL fields instead of forwarding them", () => {
  expect(
    activityQuery(
      parseActivityFilters({ populate: "*", actorKind: ["user", "admin"], actorId: ["7", "8"] }),
      zone,
    ),
  ).toEqual({ page: 1 });
});

it("keeps every filter when changing pages and omits page one", () => {
  const filters = parseActivityFilters({
    actorKind: "admin",
    actorId: "7",
    actorClass: "moderator",
    targetUid: "plugin::upload.file",
    fromDate: "2026-10-17",
    fromTime: "12:30",
    toDate: "2026-10-18",
    toTime: "18:00",
  });
  const next = new URL(activityHref(filters, 2), "https://example.test");
  expect(Object.fromEntries(next.searchParams)).toEqual({ ...filters, page: "2" });
  expect(new URL(activityHref(filters, 1), "https://example.test").searchParams.has("page")).toBe(
    false,
  );
});

it("uses server counts and pagination from one bounded request", async () => {
  const result = await loadActivity(parseActivityFilters({ page: "2" }), zone);
  expect(result).toEqual({
    rows: [],
    pagination: page.meta.pagination,
    empty: true,
    failed: false,
    invalid: false,
  });
  expect(strapiMock).toHaveBeenCalledTimes(1);
});

it("distinguishes a CMS failure from an empty result", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  strapiMock.mockRejectedValueOnce(new Error("offline"));
  expect(await loadActivity(parseActivityFilters({}), zone)).toMatchObject({
    empty: false,
    failed: true,
    invalid: false,
  });
  vi.restoreAllMocks();
});

it("preserves session-expiry redirects", async () => {
  const expired = Object.assign(new Error("expired"), {
    digest: "NEXT_REDIRECT;replace;/sign-in?expired=1;307;",
  });
  strapiMock.mockRejectedValueOnce(expired);
  await expect(loadActivity(parseActivityFilters({}), zone)).rejects.toBe(expired);
});
