import { beforeEach, describe, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";
const strapi = vi.fn();
vi.mock("@/lib/strapi/client", () => ({ strapi: (...args: unknown[]) => strapi(...args) }));
const { loadCourseEditable, loadLessonEditable, loadLessonList } = await import("./training");
const course = "c".repeat(24);
const lesson = "l".repeat(24);
beforeEach(() => {
  strapi.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("nested training reads", () => {
  it("rejects malformed URLs without a request", async () => {
    expect(await loadCourseEditable("../x")).toEqual({ state: "notFound" });
    expect(await loadLessonEditable("../x", lesson)).toEqual({ state: "notFound" });
    expect(await loadLessonEditable(course, "../x")).toEqual({ state: "notFound" });
    expect(strapi).not.toHaveBeenCalled();
  });
  it("checks the lesson's authoritative editable course against the URL", async () => {
    strapi.mockResolvedValue({
      data: { documentId: lesson, version: "1", course: { documentId: course } },
    });
    expect((await loadLessonEditable(course, lesson)).state).toBe("ok");
    expect(await loadLessonEditable("d".repeat(24), lesson)).toEqual({ state: "notFound" });
    strapi.mockResolvedValue({ data: { documentId: lesson, version: "1", course: null } });
    expect(await loadLessonEditable(course, lesson)).toEqual({ state: "notFound" });
  });
  it("distinguishes hidden and unavailable content", async () => {
    strapi.mockRejectedValueOnce(new StrapiError(403, "Forbidden", ""));
    expect(await loadCourseEditable(course)).toEqual({ state: "notFound" });
    strapi.mockRejectedValueOnce(new StrapiError(502, "Unavailable", ""));
    expect(await loadLessonEditable(course, lesson)).toEqual({ state: "failed" });
  });
  it("sends course and filters to the server in a single paginated read", async () => {
    strapi.mockResolvedValue({
      data: [],
      meta: { pagination: { page: 2, pageSize: 25, total: 26, pageCount: 2 } },
    });
    const result = await loadLessonList(course, {
      status: "draft",
      q: "Intro",
      page: 2,
      owner: null,
    });
    expect(strapi).toHaveBeenCalledOnce();
    const url = new URL(String(strapi.mock.calls[0][0]), "https://cms.example");
    expect(url.pathname).toBe("/api/lessons/authoring");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      course,
      status: "draft",
      q: "Intro",
      page: "2",
    });
    expect(result.pagination.total).toBe(26);
    strapi.mockRejectedValue(new Error("offline"));
    expect(
      await loadLessonList(course, { status: null, q: "", page: 1, owner: null }),
    ).toMatchObject({ failed: true, empty: false });
  });
});
