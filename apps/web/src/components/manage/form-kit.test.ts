import { createElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { useFieldErrorText } from "./error-text";
import { CheckboxField, CheckboxList, Field, inputClass } from "./form-controls";
import { DateTimeField, DayField } from "./date-fields";
import { EditorStatus } from "./editor-chrome";
import { MarkdownEditor } from "./markdown-editor";
import { NoDepartmentExplanation } from "./page-parts";
import { SinglePicker } from "./pickers";
import { PublishBar, publishBarButtons } from "./publish-bar";
import { sameValues } from "./use-item-editor";
import { isChecked, isDisabled, MESSAGES, render, tagById } from "./render.test.helper";
import { StatusBadges } from "./status-badges";

/**
 * The /manage form kit, server-rendered with the real catalogs (decision 06
 * §L4, §L5; batch 15 plan 15C item 2): labels tied to their controls, hints
 * and errors as descriptions, required and invalid states, the Markdown
 * editor's tabs and its sanitised preview, the badges, the publish bar per
 * role and state, the error texts, and the explanation for a department
 * head without a department.
 */
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const noop = () => undefined;
const common = MESSAGES.en.manage.common;

describe("Field", () => {
  it("ties the label, the hint and the error to the control", () => {
    const html = render(
      // eslint-disable-next-line react/no-children-prop -- Field's render prop, from a .test.ts without JSX
      createElement(Field, {
        id: "f-title",
        label: "Title",
        hint: "Short",
        error: "Please fill in this field.",
        required: true,
        children: (a11y) => createElement("input", { ...a11y, className: inputClass }),
      }),
    );
    expect(html).toContain('<label for="f-title"');
    const input = tagById(html, "f-title");
    expect(input).toContain('aria-describedby="f-title-hint f-title-error"');
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-required="true"');
    expect(html).toContain(
      '<p id="f-title-error" class="text-sm text-destructive">Please fill in this field.</p>',
    );
  });

  it("has no description and no invalid state without a hint or an error", () => {
    const html = render(
      // eslint-disable-next-line react/no-children-prop -- Field's render prop, from a .test.ts without JSX
      createElement(Field, {
        id: "f-x",
        label: "X",
        children: (a11y) => createElement("input", a11y),
      }),
    );
    expect(tagById(html, "f-x")).not.toMatch(/aria-(describedby|invalid|required)/);
  });
});

describe("SinglePicker", () => {
  const picker = (props: { hint?: string; error?: string }) =>
    render(
      createElement(SinglePicker, {
        id: "a-team",
        label: "Team",
        value: "",
        options: [
          { value: "", label: "No team" },
          { value: "t1", label: "Platform" },
        ],
        onChange: noop,
        ...props,
      }),
    );
  const trigger = (html: string) => /<button[^>]*>/.exec(html)?.[0] ?? "";

  it("describes its trigger by the hint and the error; the label names the group", () => {
    const html = picker({ hint: "Only your department's teams.", error: "Choose a team." });
    expect(trigger(html)).toContain('aria-describedby="a-team-hint a-team-error"');
    expect(html).toContain('id="a-team-hint"');
    expect(html).toContain('id="a-team-error"');
    const group = tagById(html, "a-team");
    expect(group).toContain('role="group"');
    expect(group).toContain('aria-labelledby="a-team-label"');
    expect(group).not.toMatch(/aria-describedby=/);
  });

  it("describes the trigger by the error alone, and not at all without hint and error", () => {
    expect(trigger(picker({ error: "Choose a team." }))).toContain(
      'aria-describedby="a-team-error"',
    );
    expect(trigger(picker({}))).not.toMatch(/aria-describedby=/);
  });
});

describe("checkboxes", () => {
  it("a checkbox field is labelled and described", () => {
    const html = render(
      createElement(CheckboxField, {
        id: "c-pin",
        label: "Pin",
        hint: "Stays on top",
        checked: true,
        onChange: noop,
      }),
    );
    expect(isChecked(tagById(html, "c-pin"))).toBe(true);
    expect(tagById(html, "c-pin")).toContain('aria-describedby="c-pin-hint"');
    expect(html).toContain('<label for="c-pin"');
  });

  it("a checkbox list keeps a selected value without an option, the first box carries the id", () => {
    const html = render(
      createElement(CheckboxList, {
        id: "l-roles",
        legend: "Roles",
        options: [
          { value: "member", label: "Members" },
          { value: "team_lead", label: "Team leads" },
        ],
        selected: ["team_lead", "guest"],
        onChange: noop,
      }),
    );
    expect(html).toContain("<legend");
    expect(isChecked(tagById(html, "l-roles"))).toBe(false);
    expect(isChecked(tagById(html, "l-roles-1"))).toBe(true);
    expect(isChecked(tagById(html, "l-roles-2"))).toBe(true);
    expect(html).toContain(">guest</label>");
  });
});

describe("date fields", () => {
  it("a date and a time input, each labelled, the zone named, the error on the group", () => {
    const html = render(
      createElement(DateTimeField, {
        id: "e-start",
        legend: "Starts",
        date: "2026-11-03",
        time: "10:00",
        timeZone: "Europe/Berlin",
        error: "Choose another time.",
        onDateChange: noop,
        onTimeChange: noop,
      }),
    );
    expect(tagById(html, "e-start")).toContain('type="date"');
    expect(tagById(html, "e-start-time")).toContain('type="time"');
    expect(html).toContain('<label for="e-start"');
    expect(html).toContain('<label for="e-start-time"');
    expect(html).toContain("Times are in Europe/Berlin.");
    expect(tagById(html, "e-start-group")).toContain(
      'aria-describedby="e-start-hint e-start-error"',
    );
    expect(html).not.toContain("datetime-local");
  });

  it("a day field offers days from `min`", () => {
    const html = render(
      createElement(DayField, {
        id: "p-closes",
        label: "Closes on",
        value: "",
        min: "2026-10-13",
        onChange: noop,
      }),
    );
    expect(tagById(html, "p-closes")).toContain('min="2026-10-13"');
  });
});

describe("MarkdownEditor (UI03)", () => {
  const editor = (value: string, defaultTab: "write" | "preview" = "write") =>
    render(
      createElement(MarkdownEditor, {
        id: "a-body",
        label: "Text",
        hint: common.markdown.hint,
        value,
        defaultTab,
        onChange: noop,
      }),
    );

  it("is a labelled textarea with Write and Preview tabs and a counter", () => {
    const html = editor("Hello");
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('<label for="a-body"');
    expect(tagById(html, "a-body")).toContain('aria-describedby="a-body-hint a-body-counter"');
    expect(html).toContain("5 of 200,000 characters");
  });

  it("previews with the readers' sanitiser: no script, no onerror, no javascript: link", () => {
    const html = editor(
      [
        "<script>alert(1)</script>",
        '<img src=x onerror="alert(1)">',
        "[click](javascript:alert(1))",
        "**bold**",
      ].join("\n\n"),
      "preview",
    );
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/<img[^>]*onerror/);
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("<strong>bold</strong>");
  });

  it("marks a text over the limit", () => {
    const html = editor("x".repeat(200_001));
    expect(tagById(html, "a-body")).toContain('aria-invalid="true"');
  });
});

describe("StatusBadges", () => {
  it("names the state in words: status, schedule, owner, re-targeting", () => {
    const html = render(
      createElement(StatusBadges, {
        item: {
          status: "modified",
          publishAt: "2026-11-01T07:00:00.000Z",
          ownerDepartment: { documentId: "d", name: "Engineering" },
          needsRetarget: true,
        },
        showOwner: true,
      }),
    );
    expect(html).toContain(common.status.modified);
    expect(html).toContain(`${common.status.scheduled}: `);
    expect(html).toContain("Department: Engineering");
    expect(html).toContain(common.status.needsRetarget);
  });

  it("shows a failed schedule instead of the pending one, and the owner only when asked", () => {
    const html = render(
      createElement(StatusBadges, {
        item: {
          status: "draft",
          publishAt: "2026-11-01T07:00:00.000Z",
          scheduleError: "windowExpired",
          ownerDepartment: { documentId: "d", name: "Engineering" },
        },
      }),
    );
    expect(html).toContain(common.status.scheduleFailed);
    expect(html).not.toContain(`${common.status.scheduled}: `);
    expect(html).not.toContain("Engineering");
  });
});

describe("EditorStatus: the publication state in words (issue #80)", () => {
  const meta = (status: "draft" | "published" | "modified", publishedAt: string | null) => ({
    documentId: "doc",
    version: "3",
    status,
    publishedAt,
    publishAt: null,
    unpublishAt: null,
    scheduleError: null,
  });
  const status = (item: ReturnType<typeof meta>, locale: "en" | "de" = "en", hideStatus = false) =>
    render(
      createElement(EditorStatus, { meta: item, dirty: false, showOwner: false, hideStatus }),
      locale,
    );

  it("says that an item without a published version is not shown to readers", () => {
    // Never published, unpublished, or withdrawn by its schedule: one state.
    const html = status(meta("draft", null));
    expect(html).toContain(common.detail.notPublished);
    expect(html).not.toContain(common.detail.changesPending);
    expect(status(meta("draft", null), "de")).toContain(
      MESSAGES.de.manage.common.detail.notPublished,
    );
  });

  it("says that saved changes of a published item wait for Publish, promising no readers", () => {
    const html = status(meta("modified", "2026-10-14T09:34:08.000Z"));
    expect(html).toContain(common.detail.changesPending);
    expect(html).not.toContain(common.detail.notPublished);
    // An expired announcement stays published and is hidden all the same:
    // the text says nothing about who reads the published version.
    expect(common.detail.changesPending).not.toMatch(/reader/i);
    expect(MESSAGES.de.manage.common.detail.changesPending).not.toMatch(/Leser/);
  });

  it("says nothing more for a published item, or where the status is hidden", () => {
    for (const html of [
      status(meta("published", "2026-10-14T09:34:08.000Z")),
      status(meta("draft", null), "en", true),
    ]) {
      expect(html).not.toContain(common.detail.notPublished);
      expect(html).not.toContain(common.detail.changesPending);
    }
  });
});

describe("the publish bar (§L4, §N2)", () => {
  const MODERATOR = [
    "create",
    "edit",
    "publish",
    "unpublish",
    "schedule",
    "discard",
    "delete",
  ] as const;
  const AUTHOR = ["create", "edit", "publish", "unpublish", "discard"] as const;
  const published = { status: "published" as const, publishedAt: "2026-10-01T08:00:00.000Z" };
  const modified = { status: "modified" as const, publishedAt: "2026-10-01T08:00:00.000Z" };
  const draft = { status: "draft" as const, publishedAt: null };

  it("a create: Save draft, Publish, Schedule… for moderators; no Schedule for department authors", () => {
    expect(publishBarButtons(MODERATOR, null, true)).toEqual(["saveDraft", "publish", "schedule"]);
    expect(publishBarButtons(AUTHOR, null, true)).toEqual(["saveDraft", "publish"]);
  });

  it("an unchanged draft: Publish as it is; with changes: Save and publish", () => {
    expect(publishBarButtons(MODERATOR, draft, false)).toEqual([
      "saveDraft",
      "publish",
      "schedule",
      "delete",
    ]);
    expect(publishBarButtons(MODERATOR, draft, true)).toEqual([
      "saveDraft",
      "saveAndPublish",
      "schedule",
      "delete",
    ]);
  });

  it("Unpublish while published; Discard only with a published version and pending changes", () => {
    expect(publishBarButtons(MODERATOR, published, false)).toEqual([
      "saveDraft",
      "schedule",
      "unpublish",
      "delete",
    ]);
    expect(publishBarButtons(MODERATOR, modified, false)).toEqual([
      "saveDraft",
      "publish",
      "schedule",
      "unpublish",
      "discard",
      "delete",
    ]);
  });

  it("a department author never gets Schedule… or Delete, and Discard only with publishedAt", () => {
    for (const meta of [draft, published, modified]) {
      for (const dirty of [false, true]) {
        const buttons = publishBarButtons(AUTHOR, meta, dirty);
        expect(buttons).not.toContain("schedule");
        expect(buttons).not.toContain("delete");
        if (meta.publishedAt === null) expect(buttons).not.toContain("discard");
      }
    }
    expect(publishBarButtons(AUTHOR, modified, false)).toContain("discard");
  });

  it("renders the buttons with the role's texts, and blocks the saves when asked", () => {
    const handlers = {
      saveDraft: noop,
      saveAndPublish: noop,
      publish: noop,
      unpublish: noop,
      discard: noop,
      delete: noop,
      schedule: noop,
    };
    const bar = (verbs: readonly string[], blocked = false) =>
      render(
        createElement(PublishBar, {
          area: "announcements",
          verbs: verbs as (typeof MODERATOR)[number][],
          meta: null,
          dirty: true,
          pending: false,
          blocked,
          running: null,
          handlers,
        }) as ReactElement,
      );
    const moderator = bar(MODERATOR);
    expect(moderator).toContain(`>${common.actions.saveDraft}</button>`);
    expect(moderator).toContain(`>${common.actions.publish}</button>`);
    expect(moderator).toContain(common.actions.schedule);
    expect(moderator).toContain('role="group"');
    const author = bar(AUTHOR);
    expect(author).not.toContain(common.actions.schedule);
    expect(author).not.toContain(`>${common.actions.delete}</button>`);
    const blocked = bar(MODERATOR, true);
    const save =
      blocked.match(new RegExp(`<button[^>]*>${common.actions.saveDraft}</button>`))?.[0] ?? "";
    expect(isDisabled(save)).toBe(true);
  });
});

describe("error texts (§L7)", () => {
  function Probe({
    area,
    field,
    code,
  }: {
    area: "quickLinks" | "polls";
    field: string;
    code: string;
  }) {
    return createElement("p", null, useFieldErrorText(area)(field, code));
  }

  it("prefers the area's wording for a field, else the common text, else invalid", () => {
    expect(
      render(createElement(Probe, { area: "quickLinks", field: "url", code: "invalidUrl" })),
    ).toContain(MESSAGES.en.manage.quickLinks.fields.url.invalidUrl);
    expect(
      render(createElement(Probe, { area: "polls", field: "options", code: "optionCount" })),
    ).toContain(common.errors.optionCount);
    expect(
      render(createElement(Probe, { area: "polls", field: "options", code: "brandNewCode" })),
    ).toContain(common.errors.invalid);
    expect(
      render(createElement(Probe, { area: "polls", field: "_form", code: "neverPublished" }), "de"),
    ).toContain(MESSAGES.de.manage.common.errors.neverPublished);
  });
});

describe("a department head without a department (§N1)", () => {
  it("gets the explanation", () => {
    const html = render(createElement(NoDepartmentExplanation));
    expect(html).toContain(common.departmentAuthor.noDepartmentTitle);
    expect(html).toContain(common.departmentAuthor.noDepartmentHint);
  });
});

describe("unsaved changes (sameValues)", () => {
  it("compares id lists as sets, a poll's answers in order", () => {
    expect(
      sameValues({ departments: ["a", "b"], title: "x" }, { departments: ["b", "a"], title: "x" }),
    ).toBe(true);
    expect(sameValues({ departments: ["a"] }, { departments: ["a", "b"] })).toBe(false);
    expect(sameValues({ options: ["Yes", "No"] }, { options: ["No", "Yes"] })).toBe(false);
    expect(sameValues({ title: "x", pinned: false }, { title: "x", pinned: true })).toBe(false);
  });
});

describe("Save draft on an unchanged item", () => {
  it("is disabled until something changed (an empty save would show Changes pending)", () => {
    const handlers = {
      saveDraft: noop,
      saveAndPublish: noop,
      publish: noop,
      unpublish: noop,
      discard: noop,
      delete: noop,
      schedule: noop,
    };
    const meta = {
      documentId: "d",
      version: "3",
      status: "published" as const,
      publishedAt: "2026-10-01T08:00:00.000Z",
      publishAt: null,
      unpublishAt: null,
      scheduleError: null,
    };
    const bar = (dirty: boolean) =>
      render(
        createElement(PublishBar, {
          area: "events",
          verbs: ["create", "edit", "publish", "unpublish", "discard"],
          meta,
          dirty,
          pending: false,
          running: null,
          handlers,
        }),
      );
    const save = (html: string) =>
      html.match(new RegExp(`<button[^>]*>${common.actions.saveDraft}</button>`))?.[0] ?? "";
    expect(isDisabled(save(bar(false)))).toBe(true);
    expect(isDisabled(save(bar(true)))).toBe(false);
  });
});
