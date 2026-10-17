import { redirect } from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";
import type { Viewer } from "@/lib/viewer";

const strapi = vi.fn();
vi.mock("@/lib/strapi/client", () => ({ strapi: (...args: unknown[]) => strapi(...args) }));
const { loadOrgEditable } = await import("./org");
const DOC = "dept00000000000000000001";
const viewer: Viewer = { id: 7, role: "department_head", displayName: "Ada", department: null };
const editable = {
  documentId: DOC,
  version: "4",
  name: "Engineering",
  slug: "eng",
  roleClass: "departmentHead",
  description: "<p>Raw</p>\r\n",
  color: "#123456",
};
beforeEach(() => {
  strapi.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
describe("org editable loader", () => {
  it.each(["department", "team"] as const)(
    "resolves %s slug then reads authoritative editable without queries",
    async (type) => {
      strapi
        .mockResolvedValueOnce({ data: [{ documentId: DOC, description: "reader data" }] })
        .mockResolvedValueOnce({ data: editable });
      await expect(loadOrgEditable(type, "eng", viewer)).resolves.toEqual({
        state: "ok",
        editable,
      });
      expect(strapi.mock.calls[0][0]).toContain("filters[slug][$eq]=eng");
      expect(strapi.mock.calls[1][0]).toBe(
        `/api/${type === "department" ? "departments" : "teams"}/${DOC}/editable`,
      );
    },
  );
  it("denied roles send no request; an unresolved viewer shows failure", async () => {
    await expect(loadOrgEditable("team", "eng", { ...viewer, role: "editor" })).resolves.toEqual({
      state: "notFound",
    });
    await expect(loadOrgEditable("team", "eng", { ...viewer, id: null })).resolves.toEqual({
      state: "failed",
    });
    expect(strapi).not.toHaveBeenCalled();
  });
  it("missing slug or a denied editable are indistinguishable", async () => {
    strapi.mockResolvedValueOnce({ data: [] });
    await expect(loadOrgEditable("department", "eng", viewer)).resolves.toEqual({
      state: "notFound",
    });
    for (const status of [403, 404]) {
      strapi
        .mockResolvedValueOnce({ data: [{ documentId: DOC }] })
        .mockRejectedValueOnce(new StrapiError(status, "Error", ""));
      await expect(loadOrgEditable("department", "eng", viewer)).resolves.toEqual({
        state: "notFound",
      });
    }
  });
  it("CMS outage and malformed editable fail closed; expired session redirects", async () => {
    strapi.mockRejectedValueOnce(new TypeError("network"));
    await expect(loadOrgEditable("department", "eng", viewer)).resolves.toEqual({
      state: "failed",
    });
    strapi
      .mockResolvedValueOnce({ data: [{ documentId: DOC }] })
      .mockResolvedValueOnce({ data: { ...editable, documentId: "wrong" } });
    await expect(loadOrgEditable("department", "eng", viewer)).resolves.toEqual({
      state: "failed",
    });
    let expired: unknown;
    try {
      redirect("/sign-in?expired=1");
    } catch (error) {
      expired = error;
    }
    strapi.mockRejectedValueOnce(expired);
    await expect(loadOrgEditable("department", "eng", viewer)).rejects.toBe(expired);
  });
});
