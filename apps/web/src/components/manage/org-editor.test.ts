import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { DepartmentEditable, TeamEditable } from "@sinnlos/domain";
import { MESSAGES, render, tagById } from "./render.test.helper";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/manage/org-actions", () => ({ saveOrg: vi.fn() }));
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
};
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").trim(),
  );
describe("single-row organisation form", () => {
  it("admin sees description, colour, image and one Save without publication or deletion", () => {
    const html = render(createElement(OrgEditor, { type: "department", editable: department }));
    expect(tagById(html, "org-department-description")).toContain("textarea");
    expect(html).toContain("&lt;p&gt;Raw &amp;amp; text&lt;/p&gt;");
    expect(tagById(html, "org-department-color")).toContain('type="color"');
    expect(tagById(html, "org-department-headerImage")).toContain('accept=".jpg,.jpeg,.png,.webp"');
    const labels = buttons(html);
    expect(labels.filter((label) => label === MESSAGES.en.manage.common.actions.save)).toHaveLength(
      1,
    );
    for (const key of ["publish", "schedule", "delete", "discard"] as const)
      expect(labels).not.toContain(MESSAGES.en.manage.common.actions[key]);
    expect(html).toContain('href="/departments/eng"');
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
