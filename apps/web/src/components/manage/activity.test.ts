import { createElement } from "react";
import { expect, it } from "vitest";
import type { ActivityListRow } from "@sinnlos/domain";
import { ActivityFiltersForm, ActivityList, ActivityPagination } from "./activity";
import { parseActivityFilters } from "@/lib/loaders/manage/activity";
import { render, tagById } from "./render.test.helper";

const row: ActivityListRow = {
  id: 1,
  createdAt: "2026-10-17T12:00:00Z",
  action: "delete",
  targetUid: "plugin::upload.file",
  targetDocumentId: "removed-file",
  revision: 8,
  source: "system",
  keys: ["file"],
  detail: "<script>unsafe()</script>",
  actor: { kind: "admin", id: 7, displayName: "Deleted administrator #7", class: "moderator" },
};

it.each(["en", "de"] as const)(
  "renders localized activity filters with native labels and a named zone (%s)",
  (locale) => {
    const html = render(
      createElement(ActivityFiltersForm, {
        filters: parseActivityFilters({}),
        timeZone: "Europe/Berlin",
        invalid: true,
      }),
      locale,
    );
    expect(html).toContain('method="get"');
    expect(html).toContain('action="/manage/activity"');
    expect(html).toContain('aria-describedby="activity-filter-error"');
    expect(html).toContain("Europe/Berlin");
    for (const id of [
      "activity-target",
      "activity-kind",
      "activity-actor",
      "activity-class",
      "activity-from-date",
      "activity-from-time",
      "activity-to-date",
      "activity-to-time",
    ]) {
      expect(html).toContain(`for="${id}"`);
      expect(tagById(html, id)).not.toBe("");
    }
    expect(html).not.toContain("datetime-local");
    expect(html).not.toContain('name="page"');
  },
);

it("renders actor namespace and ID, escaped details, and no broken content link", () => {
  const html = render(createElement(ActivityList, { rows: [row] }));
  expect(html).toContain("Deleted administrator #7");
  expect(html).toContain("Panel administrator #7");
  expect(html).toContain("Moderator");
  expect(html).toContain("&lt;script&gt;unsafe()&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("href=");
  expect(html).toContain("removed-file");
  expect(html).toContain("Revision 8");
});

it("identifies system actors without a made-up ID", () => {
  const html = render(
    createElement(ActivityList, {
      rows: [{ ...row, actor: { kind: "system", id: null, class: null, displayName: "System" } }],
    }),
  );
  expect(html).toContain("System");
  expect(html).not.toContain("#null");
});

it("preserves filters in both pagination links", () => {
  const html = render(
    createElement(ActivityPagination, {
      filters: parseActivityFilters({ actorKind: "user", actorId: "7" }),
      pagination: { page: 2, pageSize: 25, pageCount: 3, total: 61 },
    }),
  );
  expect(html).toContain('rel="prev"');
  expect(html).toContain('rel="next"');
  expect(html).toContain('href="/manage/activity?actorKind=user&amp;actorId=7"');
  expect(html).toContain('href="/manage/activity?actorKind=user&amp;actorId=7&amp;page=3"');
});

it("lets an out-of-range page navigate back and never offers page 10001", () => {
  const html = render(
    createElement(ActivityPagination, {
      filters: parseActivityFilters({}),
      pagination: { page: 10000, pageSize: 25, pageCount: 10001, total: 250025 },
    }),
  );
  expect(html).toContain('rel="prev"');
  expect(html).not.toContain('rel="next"');
});
