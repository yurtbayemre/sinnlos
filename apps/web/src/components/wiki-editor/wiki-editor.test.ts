import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  WikiPageEditable,
  WikiRevisionDetail,
  WikiRevisionEntry,
  WikiSpaceEditable,
} from "@sinnlos/domain";
import { MESSAGES, render, tagById } from "@/components/manage/render.test.helper";
import type { Capabilities } from "@/lib/roles";

/**
 * The wiki's forms and history, server-rendered (decision 06 §J2, §J3, §L4;
 * batch 16 plan 16C tests "the history labels" and the wiki editor per
 * class): a moderator's editor has department, team and Schedule…; an
 * author's has none of them, and a never-published draft offers "Delete
 * draft" to its author only; the parent picker; the history names the
 * three kinds and the three editor shapes (a user, the admin panel,
 * nobody); a legacy version says it restores the text only; the space form
 * shows its visibility target. Server Actions and the router are stubbed.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/manage/wiki-page-actions", () => ({
  saveWikiPage: vi.fn(),
  publishWikiPage: vi.fn(),
  unpublishWikiPage: vi.fn(),
  discardWikiPage: vi.fn(),
  deleteWikiPage: vi.fn(),
  restoreWikiRevision: vi.fn(),
}));
vi.mock("@/lib/manage/wiki-space-actions", () => ({
  saveWikiSpace: vi.fn(),
  deleteWikiSpace: vi.fn(),
}));

const { WikiPageEditor } = await import("./wiki-page-editor");
const { WikiHistoryList, WikiRevisionPreview } = await import("./wiki-history");
const { RestoreRevision } = await import("./restore-revision");
const { WikiSpaceEditor } = await import("@/components/manage/wiki-space-editor");

const t = MESSAGES.en.manage.wiki;
const tc = MESSAGES.en.manage.common;
const SPACE = { documentId: "spce00000000000000000001", name: "Handbook", slug: "handbook" };

const MODERATOR: Capabilities["wikiPages"] = {
  create: true,
  edit: "any",
  unpublish: true,
  schedule: true,
  delete: true,
};
const ROW: Capabilities["wikiPages"] = {
  create: false,
  edit: "row",
  unpublish: false,
  schedule: false,
  delete: false,
};

function editable(patch: Partial<WikiPageEditable> = {}): WikiPageEditable {
  return {
    documentId: "page00000000000000000001",
    version: "3",
    status: "modified",
    publishedAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-12T08:00:00.000Z",
    roleClass: "moderator",
    title: "Laptop setup",
    slug: "laptop-setup",
    body: "Text",
    summary: null,
    tags: ["it"],
    tocEnabled: true,
    order: 0,
    space: SPACE,
    parent: null,
    canDiscardUnpublished: true,
    department: null,
    team: null,
    publishAt: null,
    scheduleError: null,
    ...patch,
  };
}

const editorProps = {
  space: SPACE,
  timeZone: "Europe/Berlin",
  parentOptions: [
    { documentId: "page00000000000000000002", label: "Handbook" },
    { documentId: "page00000000000000000003", label: "Handbook / Accounts" },
  ],
  parentsFailed: false,
  parentsTruncated: false,
  departments: [{ documentId: "deptengineering000000000", name: "Engineering" }],
  teams: [],
  optionsFailed: false,
  optionsTruncated: false,
};

const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").trim(),
  );

describe("the wiki editor", () => {
  it("a moderator: department and team, Schedule…, Unpublish and Delete, the change note", () => {
    const html = render(
      createElement(WikiPageEditor, { ...editorProps, editable: editable(), wikiPages: MODERATOR }),
    );
    for (const id of [
      "wiki-page-title",
      "wiki-page-summary",
      "wiki-page-body",
      "wiki-page-parent",
      "wiki-page-order",
      "wiki-page-tags",
      "wiki-page-tocEnabled",
      "wiki-page-department",
      "wiki-page-team",
      "wiki-page-revisionSummary",
    ]) {
      expect(tagById(html, id), id).not.toBe("");
    }
    const labels = buttons(html);
    for (const label of [
      tc.actions.schedule,
      tc.actions.unpublish,
      tc.actions.delete,
      tc.actions.discard,
    ]) {
      expect(labels).toContain(label);
    }
    expect(html).toContain(
      'href="/wiki/handbook/laptop-setup/history?doc=page00000000000000000001"',
    );
    expect(html).toContain('href="/wiki/handbook/laptop-setup"');
  });

  it("an author: no department, team, Schedule…, Unpublish or Delete", () => {
    const html = render(
      createElement(WikiPageEditor, {
        ...editorProps,
        editable: editable({ roleClass: "author", department: undefined, team: undefined }),
        wikiPages: ROW,
      }),
    );
    expect(tagById(html, "wiki-page-department")).toBe("");
    expect(tagById(html, "wiki-page-team")).toBe("");
    const labels = buttons(html);
    for (const label of [tc.actions.schedule, tc.actions.unpublish, tc.actions.delete]) {
      expect(labels).not.toContain(label);
    }
    expect(labels).toContain(tc.actions.discard);
    expect(labels).toContain(tc.actions.saveDraft);
    expect(labels).toContain(tc.actions.publish);
  });

  it("a never-published draft: Delete draft for its author, not for another row class", () => {
    const draft = { status: "draft" as const, publishedAt: null };
    const author = render(
      createElement(WikiPageEditor, {
        ...editorProps,
        editable: editable({ ...draft, roleClass: "author", canDiscardUnpublished: true }),
        wikiPages: ROW,
      }),
    );
    expect(buttons(author)).toContain(t.editor.deleteDraft);
    // Never published: no View page link.
    expect(author).not.toContain('href="/wiki/handbook/laptop-setup"');
    const head = render(
      createElement(WikiPageEditor, {
        ...editorProps,
        editable: editable({ ...draft, roleClass: "departmentHead", canDiscardUnpublished: false }),
        wikiPages: ROW,
      }),
    );
    expect(buttons(head)).not.toContain(t.editor.deleteDraft);
  });

  it("a create: no change note and no history; the parent picker offers the space's pages", () => {
    const html = render(
      createElement(WikiPageEditor, {
        ...editorProps,
        editable: null,
        wikiPages: { ...ROW, create: true },
      }),
    );
    expect(tagById(html, "wiki-page-revisionSummary")).toBe("");
    expect(html).not.toContain("/history");
    expect(html).toContain(t.editor.fields.parent.none);
    expect(buttons(html)).toContain(tc.actions.saveDraft);
  });

  it("the parent list could not load: the picker is locked and says so", () => {
    const html = render(
      createElement(WikiPageEditor, {
        ...editorProps,
        parentsFailed: true,
        editable: editable(),
        wikiPages: MODERATOR,
      }),
    );
    expect(html).toContain(t.editor.parentsFailed);
  });

  it("renders in German", () => {
    const html = render(
      createElement(WikiPageEditor, { ...editorProps, editable: null, wikiPages: MODERATOR }),
      "de",
    );
    expect(html).toContain(MESSAGES.de.manage.wiki.editor.fields.parent.label);
  });
});

describe("the history", () => {
  const entries: WikiRevisionEntry[] = [
    {
      id: 9,
      createdAt: "2026-10-12T08:00:00.000Z",
      title: "Laptop setup",
      changeSummary: "Typos",
      kind: "after",
      editor: { id: 7, displayName: "Ada Lovelace" },
      restoredFrom: 4,
    },
    {
      id: 5,
      createdAt: "2026-10-10T08:00:00.000Z",
      title: "Laptop setup",
      changeSummary: null,
      kind: "baseline",
      editor: null,
      restoredFrom: null,
    },
    {
      id: 4,
      createdAt: "2026-09-01T08:00:00.000Z",
      title: null,
      changeSummary: null,
      kind: "before",
      editor: { admin: true },
      restoredFrom: null,
    },
  ];

  it("labels the three kinds and the three editor shapes", () => {
    const html = render(
      createElement(WikiHistoryList, {
        entries,
        spaceSlug: "handbook",
        slug: "laptop-setup",
        documentId: "page00000000000000000001",
        page: 1,
        selected: 5,
      }),
    );
    expect(html).toContain(t.history.kinds.after);
    expect(html).toContain(t.history.kinds.baseline);
    expect(html).toContain("State before an edit (older format)");
    expect(html).toContain("by Ada Lovelace");
    expect(html).toContain("in the admin panel");
    expect(html).toContain("no editor recorded");
    expect(html).toContain("Restores version #4");
    expect(html).toContain("Note: Typos");
    expect(html).toContain(t.history.untitled);
    // The selected version is marked; the others link to ?rev=.
    expect(html).toContain('aria-current="true"');
    expect(html).toContain(
      'href="/wiki/handbook/laptop-setup/history?doc=page00000000000000000001&amp;rev=9"',
    );
    expect(html).not.toContain("rev=5");
  });

  it("a legacy version's preview says that it restores the text only, and renders it safely", () => {
    const revision: WikiRevisionDetail = {
      ...entries[2]!,
      body: "Old <script>alert(1)</script> [x](javascript:alert(1))",
      pageSummary: null,
    };
    const html = render(createElement(WikiRevisionPreview, { revision }));
    expect(html).toContain(t.history.previewLegacy);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
  });

  it("the restore button names what it does", () => {
    const html = render(
      createElement(RestoreRevision, {
        page: {
          documentId: "page00000000000000000001",
          version: "3",
          status: "published",
          publishedAt: "2026-10-01T08:00:00.000Z",
        },
        revisionId: 5,
        legacy: false,
      }),
    );
    expect(buttons(html)).toContain(t.history.restore);
  });
});

describe("the space form", () => {
  const space = (patch: Partial<WikiSpaceEditable> = {}): WikiSpaceEditable => ({
    documentId: SPACE.documentId,
    version: "2",
    status: "published",
    publishedAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-01T08:00:00.000Z",
    roleClass: "moderator",
    name: "Handbook",
    slug: "handbook",
    icon: "BookOpen",
    description: null,
    visibility: "department",
    allowedRoles: [],
    department: null,
    team: null,
    needsRetarget: true,
    pageCount: 3,
    ...patch,
  });
  const props = {
    access: {
      area: "wiki" as const,
      verbs: ["create", "edit", "delete"] as ("create" | "edit" | "delete")[],
      scope: "any" as const,
      roleClass: "moderator" as const,
    },
    departments: [{ documentId: "deptengineering000000000", name: "Engineering" }],
    teams: [],
    optionsFailed: false,
    optionsTruncated: false,
  };

  it("a space whose department is gone: the notice, the Restricted picker, the page count", () => {
    const html = render(createElement(WikiSpaceEditor, { ...props, editable: space() }));
    expect(html).toContain(tc.targeting.retargetNotice);
    expect(html).toContain(tc.targeting.restricted);
    expect(html).toContain("This space has 3 pages.");
    expect(html).toContain("Address: /wiki/handbook");
    expect(buttons(html)).toContain(tc.actions.delete);
  });

  it("a role space lists the role types; a new space starts public", () => {
    const roleSpace = render(
      createElement(WikiSpaceEditor, {
        ...props,
        editable: space({ visibility: "role", allowedRoles: ["member"], needsRetarget: false }),
      }),
    );
    expect(tagById(roleSpace, "wiki-space-allowedRoles")).not.toBe("");
    expect(roleSpace).toContain(tc.targeting.roles.guest);
    const created = render(createElement(WikiSpaceEditor, { ...props, editable: null }));
    expect(tagById(created, "wiki-space-department")).toBe("");
    expect(buttons(created)).toContain(tc.actions.create);
    expect(buttons(created)).not.toContain(tc.actions.delete);
  });
});
