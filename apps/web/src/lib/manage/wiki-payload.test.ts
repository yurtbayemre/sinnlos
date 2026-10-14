import { describe, expect, it } from "vitest";
import { WIKI_FIELDS } from "@sinnlos/domain";
import {
  buildWikiPagePayload,
  buildWikiSchedulePayload,
  buildWikiSpacePayload,
  parseWikiTags,
  wikiPageKeys,
} from "./wiki-payload";
import {
  emptyWikiPageValues,
  emptyWikiSpaceValues,
  wikiPageValuesFromEditable,
} from "./wiki-values";

/**
 * The wiki payloads (batch 16 plan 16C items 4 and 5; K18): a class sends
 * exactly its WIKI_FIELDS keys, an update only what changed, the edit note
 * only when written, tags as a clean list, and a space's visibility always
 * together with its target.
 */
const NOW = Date.parse("2026-10-14T08:00:00.000Z");
const ctx = (patch: Partial<Parameters<typeof buildWikiPagePayload>[2]> = {}) => ({
  mode: "update" as const,
  roleClass: "author" as const,
  space: null,
  timeZone: "Europe/Berlin",
  now: NOW,
  ...patch,
});

describe("wiki page payloads", () => {
  it("each class's keys are WIKI_FIELDS'", () => {
    expect(wikiPageKeys({ mode: "create", roleClass: "moderator" })).toEqual([
      ...WIKI_FIELDS.wikiPage.create.moderator,
    ]);
    expect(wikiPageKeys({ mode: "create", roleClass: "teamLead" })).toEqual([
      ...WIKI_FIELDS.wikiPage.create.author,
    ]);
    for (const roleClass of ["author", "departmentHead", "teamLead"] as const) {
      expect(wikiPageKeys({ mode: "update", roleClass })).toEqual([
        ...WIKI_FIELDS.wikiPage.update[roleClass],
      ]);
    }
  });

  it("an author's update never carries department, team or a space move", () => {
    const initial = emptyWikiPageValues();
    const built = buildWikiPagePayload(
      {
        ...initial,
        title: "T",
        department: "deptx0000000000000000001",
        team: "teamx0000000000000000001",
      },
      initial,
      ctx({ space: "spce00000000000000000001" }),
    );
    expect(built).toEqual({ ok: true, data: { title: "T" } });
  });

  it("an unchanged edit sends nothing; the edit note only when written", () => {
    const initial = { ...emptyWikiPageValues(), title: "T" };
    expect(buildWikiPagePayload(initial, initial, ctx())).toEqual({ ok: true, data: {} });
    expect(buildWikiPagePayload({ ...initial, revisionSummary: "  " }, initial, ctx())).toEqual({
      ok: true,
      data: {},
    });
    expect(
      buildWikiPagePayload({ ...initial, revisionSummary: " Fixed typos " }, initial, ctx()),
    ).toEqual({ ok: true, data: { revisionSummary: "Fixed typos" } });
    expect(
      buildWikiPagePayload({ ...initial, revisionSummary: "x".repeat(256) }, initial, ctx()),
    ).toEqual({ ok: false, fields: { revisionSummary: "tooLong" } });
  });

  it("tags: split on commas, trimmed, without blanks and repeats; reordered is unchanged", () => {
    expect(parseWikiTags(" onboarding, ,Linux,linux , VPN ")).toEqual([
      "onboarding",
      "Linux",
      "VPN",
    ]);
    const initial = { ...emptyWikiPageValues(), title: "T", tags: "a, b" };
    expect(buildWikiPagePayload({ ...initial, tags: "a,b" }, initial, ctx())).toEqual({
      ok: true,
      data: {},
    });
    expect(
      buildWikiPagePayload({ ...initial, tags: `a, ${"x".repeat(101)}` }, initial, ctx()),
    ).toEqual({ ok: false, fields: { tags: "tooLong" } });
  });

  it("order 0..10000; a create carries the space and needs one", () => {
    const values = { ...emptyWikiPageValues(), title: "T", order: "10001" };
    expect(
      buildWikiPagePayload(
        values,
        null,
        ctx({ mode: "create", space: "spce00000000000000000001" }),
      ),
    ).toEqual({ ok: false, fields: { order: "invalid" } });
    expect(
      buildWikiPagePayload({ ...values, order: "" }, null, ctx({ mode: "create", space: null })),
    ).toEqual({ ok: false, fields: { space: "required" } });
  });

  it("reads the editable back unchanged (the form's start)", () => {
    const values = wikiPageValuesFromEditable({
      documentId: "page00000000000000000001",
      version: "1",
      status: "published",
      publishedAt: null,
      updatedAt: null,
      roleClass: "author",
      title: "Setup",
      slug: "setup",
      body: "Text",
      summary: null,
      tags: ["a", "b"],
      tocEnabled: false,
      order: 4,
      space: null,
      parent: "page00000000000000000002",
      canDiscardUnpublished: false,
    });
    expect(values).toMatchObject({ tags: "a, b", tocEnabled: false, order: "4", summary: "" });
    expect(buildWikiPagePayload(values, values, ctx())).toEqual({ ok: true, data: {} });
  });

  it("the schedule: a wall time in reject mode, at least a minute ahead", () => {
    const schedule = (date: string, time: string) => ({
      publishDate: date,
      publishTime: time,
      unpublishDate: "",
      unpublishTime: "",
    });
    expect(buildWikiSchedulePayload(schedule("2030-01-02", "08:00"), ctx())).toEqual({
      ok: true,
      data: { publishAt: "2030-01-02T07:00:00.000Z" },
    });
    expect(buildWikiSchedulePayload(schedule("2027-03-28", "02:30"), ctx())).toEqual({
      ok: false,
      fields: { publishAt: "timeSkipped" },
    });
    expect(buildWikiSchedulePayload(schedule("2026-10-14", "10:00"), ctx())).toEqual({
      ok: false,
      fields: { publishAt: "scheduleInPast" },
    });
    expect(buildWikiSchedulePayload(schedule("", ""), ctx())).toEqual({
      ok: true,
      data: { publishAt: null },
    });
  });
});

describe("wiki space payloads", () => {
  const space = { ...emptyWikiSpaceValues(), name: "HR" };

  it("a changed target sends the whole group, the unused targets cleared", () => {
    const initial = { ...space, visibility: "team", team: "teamx0000000000000000001" };
    expect(
      buildWikiSpacePayload({ ...initial, team: "teamy0000000000000000001" }, initial, {
        mode: "update",
      }),
    ).toEqual({
      ok: true,
      data: {
        visibility: "team",
        allowedRoles: [],
        department: null,
        team: "teamy0000000000000000001",
      },
    });
  });

  it("each visibility needs its target", () => {
    for (const [visibility, key] of [
      ["role", "allowedRoles"],
      ["department", "department"],
      ["team", "team"],
    ] as const) {
      expect(buildWikiSpacePayload({ ...space, visibility }, null, { mode: "create" })).toEqual({
        ok: false,
        fields: { [key]: "visibilityTarget" },
      });
    }
    expect(
      buildWikiSpacePayload({ ...space, visibility: "secret" }, null, { mode: "create" }),
    ).toEqual({ ok: false, fields: { visibility: "invalid" } });
  });

  it("an icon outside ICON_KEYS is refused; a legacy icon left alone is not sent", () => {
    expect(buildWikiSpacePayload({ ...space, icon: "book" }, null, { mode: "create" })).toEqual({
      ok: false,
      fields: { icon: "invalid" },
    });
    const legacy = { ...space, icon: "book" };
    expect(
      buildWikiSpacePayload({ ...legacy, name: "People" }, legacy, { mode: "update" }),
    ).toEqual({ ok: true, data: { name: "People" } });
  });
});
