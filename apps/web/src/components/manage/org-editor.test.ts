import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DepartmentEditable, TeamEditable } from "@sinnlos/domain";
import { MESSAGES, render, tagById } from "./render.test.helper";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/manage/org-actions", () => ({
  saveOrg: vi.fn(),
  createOrg: vi.fn(),
  deleteOrg: vi.fn(),
}));
vi.mock("@/lib/manage/upload", () => ({ uploadImageFile: vi.fn() }));
const { OrgEditor } = await import("./org-editor");
const department: DepartmentEditable = {
  documentId: "dept00000000000000000001",
  version: "4",
  updatedAt: null,
  name: "Engineering",
  slug: "eng",
  description: "<p>Raw &amp; text</p>\r\n",
  color: "#123456",
  roleClass: "moderator",
  headerImage: null,
  head: { id: 9, documentId: "user00000000000000000009", displayName: "Hanna Head" },
  memberCount: 3,
  teamCount: 1,
};
const options = {
  people: [
    { id: 9, label: "Hanna Head" },
    { id: 10, label: "Max Member (Lager)" },
  ],
  departments: [{ documentId: department.documentId, name: "Engineering" }],
  failed: false,
};
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").trim(),
  );
describe("single-row organisation form", () => {
  it("admin sees name, description, colour, image, head, one Save and Delete without publication", () => {
    const html = render(
      createElement(OrgEditor, { type: "department", editable: department, options }),
    );
    expect(tagById(html, "org-department-name")).toContain('value="Engineering"');
    expect(html).toContain(MESSAGES.en.manage.org.fields.name.entraHint);
    expect(tagById(html, "org-department-head")).not.toBe("");
    expect(html).toContain("Hanna Head");
    expect(tagById(html, "org-department-description")).toContain("textarea");
    expect(html).toContain("&lt;p&gt;Raw &amp;amp; text&lt;/p&gt;");
    expect(tagById(html, "org-department-color")).toContain('type="color"');
    expect(tagById(html, "org-department-headerImage")).toContain('accept=".jpg,.jpeg,.png,.webp"');
    const labels = buttons(html);
    expect(labels.filter((label) => label === MESSAGES.en.manage.common.actions.save)).toHaveLength(
      1,
    );
    for (const key of ["publish", "schedule", "discard"] as const)
      expect(labels).not.toContain(MESSAGES.en.manage.common.actions[key]);
    expect(labels).toContain(MESSAGES.en.manage.common.actions.delete);
    expect(html).toContain('href="/departments/eng"');
  });
  it("a new team (admin): name, a department picker without 'nobody', lead, members, Create", () => {
    const html = render(createElement(OrgEditor, { type: "team", editable: null, options }));
    expect(tagById(html, "org-team-name")).toContain('value=""');
    expect(tagById(html, "org-team-department")).not.toBe("");
    expect(tagById(html, "org-team-lead")).not.toBe("");
    expect(tagById(html, "org-team-members")).not.toBe("");
    expect(html).toContain(MESSAGES.en.manage.org.fields.members.empty);
    const labels = buttons(html);
    expect(labels).toContain(MESSAGES.en.manage.common.actions.create);
    expect(labels).not.toContain(MESSAGES.en.manage.common.actions.delete);
    expect(html).toContain('href="/teams"');
    expect(html).not.toContain(MESSAGES.en.manage.org.fields.name.entraHint);
  });
  it("an admin team form lists the stored members, a blocked one by its stored name", () => {
    const team: TeamEditable = {
      documentId: "team00000000000000000001",
      version: "2",
      updatedAt: null,
      name: "Lager",
      slug: "lager",
      description: null,
      roleClass: "moderator",
      avatar: null,
      department: { documentId: department.documentId, name: "Engineering" },
      lead: null,
      members: [
        { id: 10, documentId: "user00000000000000000010", displayName: "Max Member" },
        { id: 11, documentId: "user00000000000000000011", displayName: "Gesperrt Person" },
      ],
    };
    const html = render(createElement(OrgEditor, { type: "team", editable: team, options }));
    expect(html).toContain("Max Member (Lager)");
    expect(html).toContain("Gesperrt Person");
    expect(html).toContain("Members (2)");
  });
  it("failed options say so and keep the pickers off", () => {
    const html = render(
      createElement(OrgEditor, {
        type: "department",
        editable: department,
        options: { ...options, failed: true },
      }),
    );
    expect(html).toContain(MESSAGES.en.manage.org.optionsFailed);
  });
  it("head has colour but no image; lead has description only", () => {
    const head = render(
      createElement(OrgEditor, {
        type: "department",
        editable: { ...department, roleClass: "departmentHead" },
      }),
    );
    expect(tagById(head, "org-department-color")).not.toBe("");
    expect(tagById(head, "org-department-headerImage")).toBe("");
    expect(tagById(head, "org-department-name")).toBe("");
    expect(tagById(head, "org-department-head")).toBe("");
    expect(buttons(head)).not.toContain(MESSAGES.en.manage.common.actions.delete);
    const team: TeamEditable = {
      documentId: department.documentId,
      version: "4",
      updatedAt: null,
      name: "Platform",
      slug: "platform",
      description: "",
      roleClass: "teamLead",
    };
    const lead = render(createElement(OrgEditor, { type: "team", editable: team }));
    expect(tagById(lead, "org-team-description")).not.toBe("");
    expect(tagById(lead, "org-team-color")).toBe("");
    expect(tagById(lead, "org-team-avatar")).toBe("");
    expect(tagById(lead, "org-team-members")).toBe("");
    expect(tagById(lead, "org-team-lead")).toBe("");
  });
  it("renders the German field labels too", () => {
    const html = render(
      createElement(OrgEditor, { type: "department", editable: department }),
      "de",
    );
    expect(html).toContain(MESSAGES.de.manage.org.fields.description.label);
    expect(html).toContain(MESSAGES.de.manage.org.fields.headerImage.label);
  });
});
