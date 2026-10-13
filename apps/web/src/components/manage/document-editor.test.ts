import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { DOCUMENT_UPLOAD_ACCEPT, type DocumentEditable } from "@sinnlos/domain";
import type { AreaAccess } from "@/lib/manage/access";
import { MESSAGES, render, tagById } from "./render.test.helper";

/**
 * The document form, server-rendered (decision 06 §L4, §L6, §N2; batch 16
 * plan 16C tests "the file input" and "the department-author documents
 * form"): the file input with the domain's accept list, labelled "Choose a
 * file" or "Replace the file", the stored file's download link through the
 * session-gated /uploads proxy; a department author's form shows their
 * department read-only (no department list), has neither Schedule… nor
 * Delete, and offers Discard changes only with a published version. The
 * Server Actions and the router are stubbed.
 */
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/manage/document-actions", () => ({
  saveDocument: vi.fn(),
  publishDocument: vi.fn(),
  unpublishDocument: vi.fn(),
  discardDocument: vi.fn(),
  deleteDocument: vi.fn(),
}));
vi.mock("@/lib/manage/upload", () => ({ uploadDocumentFile: vi.fn() }));

const { DocumentEditor } = await import("./document-editor");
const { DocumentPreview } = await import("./previews");

const t = MESSAGES.en.manage;
const ENG = { documentId: "deptengineering000000000", name: "Engineering" };
const SALES = { documentId: "deptsales000000000000000", name: "Sales" };
const MODERATOR: AreaAccess = {
  area: "documents",
  verbs: ["create", "edit", "publish", "unpublish", "schedule", "discard", "delete"],
  scope: "any",
  roleClass: "moderator",
};
const AUTHOR: AreaAccess = {
  area: "documents",
  verbs: ["create", "edit", "publish", "unpublish", "discard"],
  scope: "ownDepartment",
  roleClass: "departmentAuthor",
};
const props = {
  timeZone: "Europe/Berlin",
  departments: [ENG, SALES],
  optionsFailed: false,
  optionsTruncated: false,
};

function editable(patch: Partial<DocumentEditable> = {}): DocumentEditable {
  return {
    documentId: "docu00000000000000000001",
    version: "4",
    status: "modified",
    publishedAt: "2026-10-01T08:00:00.000Z",
    updatedAt: "2026-10-12T08:00:00.000Z",
    roleClass: "moderator",
    title: "Travel policy",
    description: "For trips.",
    category: "policy",
    departments: [ENG.documentId],
    file: {
      id: 40,
      name: "travel.pdf",
      mime: "application/pdf",
      size: 2048,
      url: "/uploads/travel_ab12.pdf",
    },
    ownerDepartment: null,
    needsRetarget: false,
    authorName: "Ada Lovelace",
    ...patch,
  };
}

/** The visible text of every button. */
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").trim(),
  );

describe("the file input (§L6)", () => {
  it("takes the domain's accept list, labelled Choose a file on a create", () => {
    const html = render(
      createElement(DocumentEditor, {
        ...props,
        editable: null,
        access: MODERATOR,
        ownDepartment: null,
      }),
    );
    const input = tagById(html, "document-file");
    expect(input).toContain('type="file"');
    expect(input).toContain(`accept="${DOCUMENT_UPLOAD_ACCEPT}"`);
    expect(input).toContain('aria-describedby="document-file-hint"');
    expect(html).toMatch(
      new RegExp(`<label[^>]*for="document-file"[^>]*>[\\s\\S]*?${t.documents.fields.file.choose}`),
    );
    expect(html).toContain(t.documents.fields.file.none);
    expect(html).toContain(t.documents.fields.file.hint);
  });

  it("an existing document: Replace the file, and the stored file downloads through /uploads", () => {
    const html = render(
      createElement(DocumentEditor, {
        ...props,
        editable: editable(),
        access: MODERATOR,
        ownDepartment: null,
      }),
    );
    expect(html).toContain(t.documents.fields.file.replace);
    expect(html).toContain("travel.pdf");
    expect(html).toContain("2.0 MB");
    expect(html).toContain('href="/uploads/travel_ab12.pdf"');
  });
});

describe("the moderator's form", () => {
  it("every field, the department list, Schedule… and Delete", () => {
    const html = render(
      createElement(DocumentEditor, {
        ...props,
        editable: editable(),
        access: MODERATOR,
        ownDepartment: null,
      }),
    );
    for (const id of [
      "document-title",
      "document-description",
      "document-category",
      "document-file",
      "document-departments",
    ]) {
      expect(tagById(html, id), id).not.toBe("");
    }
    const labels = buttons(html);
    expect(labels).toContain(t.common.actions.schedule);
    expect(labels).toContain(t.common.actions.delete);
    expect(labels).toContain(t.common.actions.discard);
  });
});

describe("the department author's form (amendment 1, §N2)", () => {
  const authorEditable = (patch: Partial<DocumentEditable> = {}) =>
    editable({
      roleClass: "departmentAuthor",
      ownerDepartment: { documentId: ENG.documentId, name: ENG.name },
      ...patch,
    });

  it("their department read-only, no department list, no Schedule… and no Delete", () => {
    const html = render(
      createElement(DocumentEditor, {
        ...props,
        departments: [],
        editable: authorEditable(),
        access: AUTHOR,
        ownDepartment: ENG,
      }),
    );
    expect(html).toContain(t.common.departmentAuthor.department);
    expect(html).toContain(">Engineering</dd>");
    expect(tagById(html, "document-departments")).toBe("");
    const labels = buttons(html);
    expect(labels).not.toContain(t.common.actions.schedule);
    expect(labels).not.toContain(t.common.actions.delete);
    // A published version exists and the draft differs: Discard changes.
    expect(labels).toContain(t.common.actions.discard);
    // Their own items carry no Department badge (it is always theirs).
    expect(html).not.toContain("Department: Engineering");
  });

  it("Discard changes only while a published version exists (§N2)", () => {
    const html = render(
      createElement(DocumentEditor, {
        ...props,
        departments: [],
        editable: authorEditable({ status: "draft", publishedAt: null }),
        access: AUTHOR,
        ownDepartment: ENG,
      }),
    );
    expect(buttons(html)).not.toContain(t.common.actions.discard);
  });

  it("renders in German too", () => {
    const html = render(
      createElement(DocumentEditor, {
        ...props,
        departments: [],
        editable: null,
        access: AUTHOR,
        ownDepartment: ENG,
      }),
      "de",
    );
    expect(html).toContain(MESSAGES.de.manage.documents.fields.file.choose);
    expect(html).toContain(MESSAGES.de.manage.common.departmentAuthor.department);
  });
});

describe("the preview", () => {
  it("shows the uploader and links the file through /uploads", () => {
    const html = render(createElement(DocumentPreview, { editable: editable() }));
    expect(html).toContain("Uploaded by Ada Lovelace");
    expect(html).toContain('href="/uploads/travel_ab12.pdf"');
    expect(html).toContain("Travel policy");
  });

  it("says when no file is attached", () => {
    const html = render(createElement(DocumentPreview, { editable: editable({ file: null }) }));
    expect(html).toContain(t.documents.preview.noFile);
  });
});
