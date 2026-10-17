import { beforeEach, describe, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import type { Viewer } from "@/lib/viewer";
import { StrapiError } from "@/lib/strapi-error";
import { emptyCourseValues, emptyLessonValues } from "./training-values";
const strapi = vi.fn();
const refresh = vi.fn();
let role: string | null = "editor";
vi.mock("@/lib/strapi/client", () => ({ strapi: (...args: unknown[]) => strapi(...args) }));
vi.mock("next/cache", () => ({ refresh: () => refresh() }));
vi.mock("@/lib/viewer", () => ({
  getViewer: async (): Promise<Viewer> => ({
    id: 1,
    displayName: "Author",
    role,
    department: null,
  }),
}));
const actions = await import("./training-actions");
const id = "c".repeat(24);
const values = { ...emptyCourseValues(), title: "Course" };
const dto = { documentId: id, version: "5", status: "draft", publishedAt: null };
beforeEach(() => {
  role = "editor";
  strapi.mockReset().mockResolvedValue({ data: dto });
  refresh.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("training actions", () => {
  it("creates and updates with explicit status and If-Match", async () => {
    expect(await actions.saveCourse({ values, status: "draft" })).toEqual({ ok: true, data: dto });
    expect(strapi).toHaveBeenLastCalledWith(
      "/api/courses?status=draft",
      expect.objectContaining({ method: "POST", headers: {} }),
    );
    await actions.saveCourse({
      documentId: id,
      version: "4",
      status: "published",
      initial: values,
      values: { ...values, title: "Edited" },
    });
    expect(strapi).toHaveBeenLastCalledWith(
      `/api/courses/${id}?status=published`,
      expect.objectContaining({
        method: "PUT",
        headers: { "If-Match": '"4"' },
        body: JSON.stringify({ data: { title: "Edited" } }),
      }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });
  it.each(["member", "department_head", "team_lead", "guest", null])(
    "refuses %s before any training request",
    async (value) => {
      role = value;
      expect(await actions.saveCourse({ values, status: "draft" })).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await actions.publishLesson(id, "1")).toMatchObject({ ok: false, code: "forbidden" });
      expect(strapi).not.toHaveBeenCalled();
    },
  );
  it("sends only publishAt for scheduling and validates quiz before calling the CMS", async () => {
    await actions.saveLesson({
      values: { ...emptyLessonValues(id), title: "Lesson" },
      status: "draft",
      schedule: {
        publishDate: "2030-01-02",
        publishTime: "10:00",
        unpublishDate: "2030-01-03",
        unpublishTime: "10:00",
      },
    });
    const sent = JSON.parse(strapi.mock.calls[0][1].body).data;
    expect(sent).toHaveProperty("publishAt");
    expect(sent).not.toHaveProperty("unpublishAt");
    strapi.mockClear();
    expect(
      await actions.saveLesson({
        values: { ...emptyLessonValues(id), title: "Lesson", quiz: [{}] },
        status: "draft",
      }),
    ).toMatchObject({ ok: false, fields: { quiz: "quizInvalid" } });
    expect(strapi).not.toHaveBeenCalled();
  });
  it("preserves conflict/version and never-published refusal, never provides delete", async () => {
    strapi.mockRejectedValueOnce(
      new StrapiError(412, "Conflict", JSON.stringify({ error: { details: { current: 8 } } })),
    );
    expect(await actions.publishCourse(id, "2")).toMatchObject({
      ok: false,
      code: "conflict",
      version: "8",
    });
    strapi.mockRejectedValueOnce(
      new StrapiError(
        400,
        "Invalid",
        JSON.stringify({
          error: { details: { keys: ["_form"], codes: { _form: "neverPublished" } } },
        }),
      ),
    );
    expect(await actions.discardLesson(id, "2")).toMatchObject({
      ok: false,
      fields: { _form: "neverPublished" },
    });
    expect(Object.keys(actions).some((key) => /delete/i.test(key))).toBe(false);
  });
  it("preserves the sign-in redirect and maps outage without success", async () => {
    let signIn: unknown;
    try {
      redirect("/sign-in?expired=1");
    } catch (error) {
      signIn = error;
    }
    strapi.mockRejectedValueOnce(signIn);
    await expect(actions.saveCourse({ values, status: "draft" })).rejects.toBe(signIn);
    strapi.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await actions.saveCourse({ values, status: "draft" })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });
});
