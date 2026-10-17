import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_MARKDOWN_LENGTH } from "@sinnlos/domain";
import { StrapiError } from "@/lib/strapi-error";
import type { Viewer } from "@/lib/viewer";
import { canEditOrg } from "./org-access";
import { buildOrgPayload, orgValuesFromEditable, coerceOrgValues } from "./org-values";

const strapi = vi.fn();
const refresh = vi.fn();
let viewer: Viewer;
vi.mock("@/lib/strapi/client", () => ({ strapi: (...args: unknown[]) => strapi(...args) }));
vi.mock("next/cache", () => ({ refresh: () => refresh() }));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => viewer }));
const { saveOrg } = await import("./org-actions");
const DOC = "dept00000000000000000001";
const department = { id: 3, documentId: DOC, name: "Engineering", slug: "eng" };
const media = { id: 40, name: "cover.png", mime: "image/png", url: "/uploads/cover.png", size: 10 };
const initial = {
  description: " <p>Legacy &amp; <b>text</b></p>\r\n",
  color: "#123456",
  image: media,
};
const input = { documentId: DOC, version: "4", initial, values: { ...initial, color: "#abcdef" } };
const cmsError = (status: number, details = {}) =>
  new StrapiError(status, "Error", JSON.stringify({ error: { status, details } }));
const body = () => JSON.parse(strapi.mock.calls.at(-1)![1].body).data;

beforeEach(() => {
  viewer = { id: 7, role: "admin_role", displayName: "Ada", department };
  strapi.mockReset().mockResolvedValue({ data: { documentId: DOC, version: "5" } });
  refresh.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("org row-aware presentation", () => {
  const team = {
    id: 8,
    documentId: "team00000000000000000001",
    name: "Platform",
    slug: "platform",
    department,
    lead: { id: 9 },
  };
  it("admins edit every row; heads only their department and its teams", () => {
    expect(canEditOrg("department", department, viewer)).toBe(true);
    viewer.role = "department_head";
    expect(canEditOrg("department", department, viewer)).toBe(true);
    expect(canEditOrg("team", team, viewer)).toBe(true);
    viewer.department = { ...department, id: 10 };
    expect(canEditOrg("department", department, viewer)).toBe(false);
    expect(canEditOrg("team", team, viewer)).toBe(false);
  });
  it("preserves lead precedence even for a head in another department", () => {
    viewer = { ...viewer, id: 9, role: "department_head", department: null };
    expect(canEditOrg("team", team, viewer)).toBe(true);
    viewer.role = "team_lead";
    expect(canEditOrg("team", team, viewer)).toBe(true);
    expect(canEditOrg("department", department, viewer)).toBe(false);
    viewer.id = 8;
    expect(canEditOrg("team", team, viewer)).toBe(false);
  });
  it.each(["editor", "member", "guest", "authenticated", "Admin_role", null])(
    "%s gets no edit link, even when lead",
    (role) => {
      viewer = { ...viewer, id: 9, role };
      expect(canEditOrg("department", department, viewer)).toBe(false);
      expect(canEditOrg("team", team, viewer)).toBe(false);
    },
  );
});

describe("org values and minimal payload", () => {
  it.each([
    initial.description,
    "# Markdown\n\n**strong**",
    "plain\r\n text",
    '<img src=x onerror="alert(1)">',
    "x".repeat(MAX_MARKDOWN_LENGTH + 1),
  ])("preserves description bytes on unrelated saves (%#)", (description) => {
    const values = orgValuesFromEditable({
      ...department,
      version: "4",
      updatedAt: null,
      roleClass: "moderator",
      color: initial.color,
      description,
      headerImage: media,
    });
    expect(values.description).toBe(description);
    expect(
      buildOrgPayload("department", "moderator", { ...values, color: "#abcdef" }, values),
    ).toEqual({ ok: true, data: { color: "#abcdef" } });
    expect(buildOrgPayload("department", "moderator", { ...values, image: null }, values)).toEqual({
      ok: true,
      data: { headerImage: null },
    });
  });
  it("sends edited Markdown exactly and validates only edited fields", () => {
    expect(
      buildOrgPayload(
        "department",
        "moderator",
        { ...initial, description: "  # Edited\n" },
        initial,
      ),
    ).toEqual({ ok: true, data: { description: "  # Edited\n" } });
    expect(
      buildOrgPayload(
        "department",
        "moderator",
        { ...initial, description: "x".repeat(MAX_MARKDOWN_LENGTH + 1), color: "red" },
        initial,
      ),
    ).toEqual({ ok: false, fields: { description: "tooLong", color: "invalid" } });
  });
  it("head and lead payloads never include image ids or structure", () => {
    for (const roleClass of ["departmentHead", "teamLead"] as const) {
      expect(
        buildOrgPayload(
          "team",
          roleClass,
          { ...initial, description: "New", image: null },
          initial,
        ),
      ).toEqual({ ok: true, data: { description: "New" } });
    }
    expect(
      buildOrgPayload(
        "department",
        "departmentHead",
        { ...initial, color: "#abcdef", image: null },
        initial,
      ),
    ).toEqual({ ok: true, data: { color: "#abcdef" } });
  });
  it("keeps an unchanged image by id and refuses malformed values", () => {
    expect(
      buildOrgPayload(
        "team",
        "moderator",
        { ...initial, image: { ...media, name: "other label" } },
        initial,
      ),
    ).toEqual({ ok: true, data: {} });
    expect(coerceOrgValues({ description: 1, color: "x" })).toBeNull();
    expect(coerceOrgValues(null)).toBeNull();
    expect(coerceOrgValues({ ...initial, image: { id: -1 } })).toBeNull();
  });
});

describe("org save actions", () => {
  it("sends one status-free PUT with If-Match, only changed fields and refreshes on success", async () => {
    await expect(saveOrg("department", input)).resolves.toEqual({
      ok: true,
      data: { documentId: DOC, version: "5" },
    });
    expect(strapi).toHaveBeenCalledWith(
      `/api/departments/${DOC}`,
      expect.objectContaining({ method: "PUT", headers: { "If-Match": '\"4\"' } }),
    );
    expect(body()).toEqual({ color: "#abcdef" });
    expect(refresh).toHaveBeenCalledOnce();
  });
  it("lets only admins submit images and keeps head text edits", async () => {
    await saveOrg("team", { ...input, values: { ...initial, image: null } });
    expect(body()).toEqual({ avatar: null });
    viewer.role = "department_head";
    await saveOrg("team", { ...input, values: { ...initial, description: "New", image: null } });
    expect(body()).toEqual({ description: "New" });
  });
  it.each(["editor", "member", "guest", "authenticated", null])(
    "refuses %s before writing",
    async (role) => {
      viewer.role = role;
      await expect(saveOrg("department", input)).resolves.toEqual({ ok: false, code: "forbidden" });
      expect(strapi).not.toHaveBeenCalled();
    },
  );
  it("refuses missing viewer, bad reference or malformed values before writes", async () => {
    viewer.id = null;
    await expect(saveOrg("department", input)).resolves.toEqual({ ok: false, code: "unavailable" });
    viewer.id = 7;
    for (const bad of [
      null,
      { ...input, documentId: "../users" },
      { ...input, version: undefined },
      { ...input, values: null },
      { ...input, initial: null },
    ]) {
      await expect(saveOrg("department", bad as never)).resolves.toEqual({
        ok: false,
        code: "invalid",
      });
    }
    expect(strapi).not.toHaveBeenCalled();
  });
  it.each([
    [403, "forbidden"],
    [404, "notFound"],
    [428, "failed"],
    [500, "unavailable"],
  ])("maps CMS %s without refreshing", async (status, code) => {
    strapi.mockRejectedValue(cmsError(status as number));
    await expect(saveOrg("department", input)).resolves.toEqual({ ok: false, code });
    expect(refresh).not.toHaveBeenCalled();
  });
  it("returns a stale revision for explicit overwrite, then uses the replacement version", async () => {
    strapi.mockRejectedValueOnce(cmsError(412, { current: "8" }));
    await expect(saveOrg("department", input)).resolves.toEqual({
      ok: false,
      code: "conflict",
      version: "8",
    });
    await saveOrg("department", { ...input, version: "8" });
    expect(strapi.mock.calls.at(-1)![1].headers).toEqual({ "If-Match": '\"8\"' });
    expect(body()).toEqual({ color: "#abcdef" });
  });
  it("returns field errors, handles outages, and rethrows expired-session redirect", async () => {
    strapi.mockRejectedValueOnce(
      cmsError(400, { keys: ["headerImage"], codes: { headerImage: "invalid" } }),
    );
    await expect(saveOrg("department", input)).resolves.toEqual({
      ok: false,
      code: "invalid",
      fields: { headerImage: "invalid" },
    });
    strapi.mockRejectedValueOnce(new TypeError("network"));
    await expect(saveOrg("department", input)).resolves.toEqual({ ok: false, code: "unavailable" });
    let expired: unknown;
    try {
      redirect("/sign-in?expired=1");
    } catch (error) {
      expired = error;
    }
    strapi.mockRejectedValueOnce(expired);
    await expect(saveOrg("department", input)).rejects.toBe(expired);
  });
});
