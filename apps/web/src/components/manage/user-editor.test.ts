import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import type { UserAdminDetail } from "@sinnlos/domain";
import { MESSAGES, isChecked, isDisabled, render, tagById } from "./render.test.helper";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/manage/user-actions", () => ({ saveUser: vi.fn(), handRoleToEntra: vi.fn() }));
const { UserEditor } = await import("./user-editor");

const user: UserAdminDetail = {
  id: 12,
  documentId: "user00000000000000000012",
  displayName: "Casey Jones",
  email: "casey@example.test",
  role: "member",
  roleSource: "manual",
  entraBound: false,
  blocked: true,
  department: { documentId: "dept00000000000000000001", name: "Design" },
  manager: { id: 99, displayName: "Former Boss" },
  teams: [{ documentId: "team00000000000000000001", name: "Platform" }],
  createdAt: null,
  self: false,
  locked: { department: false, manager: false },
};
const options = {
  people: [
    { id: 3, label: "Riley Kim (Head of Design)" },
    { id: 12, label: "Casey Jones" },
  ],
  departments: [{ documentId: "dept00000000000000000001", name: "Design" }],
  failed: false,
};
const en = MESSAGES.en.manage.users;
const buttonLabels = (html: string) =>
  [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) =>
    m[1].replace(/<[^>]+>/g, "").trim(),
  );

describe("user form (v0.23)", () => {
  it("shows role, department, manager, blocked and teams; a blocked manager by name", () => {
    const html = render(createElement(UserEditor, { user, options }));
    expect(tagById(html, "user-role")).not.toBe("");
    expect(tagById(html, "user-department")).not.toBe("");
    expect(tagById(html, "user-manager")).not.toBe("");
    expect(isChecked(tagById(html, "user-blocked"))).toBe(true);
    expect(isDisabled(tagById(html, "user-blocked"))).toBe(false);
    expect(html).toContain("Former Boss");
    expect(html).toContain("Platform");
    expect(html).toContain("casey@example.test");
    expect(html).not.toContain(en.handBack.button);
  });
  it("the caller themself: role and blocked are off, with the hint", () => {
    const html = render(createElement(UserEditor, { user: { ...user, self: true }, options }));
    expect(html).toContain(en.selfHint);
    expect(isDisabled(tagById(html, "user-blocked"))).toBe(true);
    expect(isDisabled(html.match(/<div id="user-role"[\s\S]*?<button[^>]*>/)?.[0] ?? "")).toBe(
      true,
    );
  });
  it("fields Entra owns are read-only with the hint", () => {
    const html = render(
      createElement(UserEditor, {
        user: { ...user, entraBound: true, locked: { department: true, manager: true } },
        options,
      }),
    );
    // Read-only inputs: a refused save can focus them (Codex v0.23).
    for (const id of ["user-department", "user-manager"]) {
      expect(tagById(html, id)).toContain("<input");
      expect(tagById(html, id)).toContain("readOnly");
    }
    expect(html.split(en.lockedHint)).toHaveLength(3);
  });
  it("hand-back only for an Entra-bound user with a hand-set role, never for oneself", () => {
    const manual = render(
      createElement(UserEditor, { user: { ...user, entraBound: true }, options }),
    );
    expect(buttonLabels(manual)).toContain(en.handBack.button);
    expect(manual).toContain(en.roleSource.manual);
    for (const other of [
      { ...user, entraBound: true, roleSource: "entra" as const },
      { ...user, entraBound: false },
      { ...user, entraBound: true, self: true },
    ])
      expect(
        buttonLabels(render(createElement(UserEditor, { user: other, options }))),
      ).not.toContain(en.handBack.button);
  });
  it("failed options say so", () => {
    const html = render(createElement(UserEditor, { user, options: { ...options, failed: true } }));
    expect(html).toContain(en.optionsFailed);
  });
  it("renders the German labels", () => {
    const html = render(createElement(UserEditor, { user, options }), "de");
    expect(html).toContain(MESSAGES.de.manage.users.fields.blocked.label);
  });
});
