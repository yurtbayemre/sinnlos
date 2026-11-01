import { describe, expect, it, vi } from "vitest";

import { fromWebServer } from "../api/upload-access/controllers/upload-access";
import { mayOpenUpload, resolveUploadFile, uploadReferenceNames } from "./upload-access";

/**
 * The pure parts of the upload access decision (v0.34, B1): which names a
 * text references, how a name finds its file, and the controller's secret.
 * The rules themselves run against a real cms in
 * integration/upload-access.integration.test.ts.
 */

describe("uploadReferenceNames", () => {
  it("reads relative and absolute references, images and links alike", () => {
    const text = [
      "![Team](/uploads/team_a1b2c3.png)",
      "[Policy](https://intranet.example/uploads/policy_d4e5f6.pdf 'Policy')",
      "See /uploads/plain_0a0b0c.pdf.",
      "<https://intranet.example/uploads/auto_111111.jpg>",
      "[ref]: /uploads/small_team_a1b2c3.png",
    ].join("\n");
    expect([...uploadReferenceNames(text)].sort()).toEqual([
      "auto_111111.jpg",
      "plain_0a0b0c.pdf",
      "policy_d4e5f6.pdf",
      "small_team_a1b2c3.png",
      "team_a1b2c3.png",
    ]);
  });

  it("takes one path segment and stops at a query or a fragment", () => {
    expect([
      ...uploadReferenceNames("https://blog.example/wp-content/uploads/2024/05/x.png"),
    ]).toEqual(["2024"]);
    expect([...uploadReferenceNames("/uploads/a_1.pdf?download=1#page=2")]).toEqual(["a_1.pdf"]);
  });

  it("finds nothing in other text or other values", () => {
    expect(uploadReferenceNames("no files here /upload/x.png").size).toBe(0);
    expect(uploadReferenceNames(null).size).toBe(0);
    expect(uploadReferenceNames(42).size).toBe(0);
  });
});

/** A file table of rows, looked up by `where.url` like the entity query. */
function filesDb(rows: Array<Record<string, unknown>>) {
  const findOne = vi.fn(
    async ({ where }: { where: { url: string } }) =>
      rows.find((row) => row.url === where.url) ?? null,
  );
  return { strapi: { db: { query: () => ({ findOne }) } }, findOne };
}

const IMAGE = {
  id: 7,
  url: "/uploads/team_a1b2c3.png",
  formats: { thumbnail: { url: "/uploads/thumbnail_team_a1b2c3.png" } },
  provider_metadata: { uploadedBy: 12 },
};

describe("resolveUploadFile", () => {
  it("finds a file by its stored URL, with the names of its renditions", async () => {
    const { strapi } = filesDb([IMAGE]);
    expect(await resolveUploadFile(strapi, "team_a1b2c3.png")).toEqual({
      id: 7,
      names: ["team_a1b2c3.png", "thumbnail_team_a1b2c3.png"],
      uploadedBy: 12,
    });
  });

  it("finds a rendition only when the stored formats name it", async () => {
    const { strapi } = filesDb([IMAGE]);
    expect((await resolveUploadFile(strapi, "thumbnail_team_a1b2c3.png"))?.id).toBe(7);
    expect(await resolveUploadFile(strapi, "large_team_a1b2c3.png")).toBeNull();
  });

  it("reads formats stored as text and files without a stamp", async () => {
    const { strapi } = filesDb([
      {
        id: 3,
        url: "/uploads/p_1.png",
        formats: JSON.stringify({ small: { url: "/uploads/small_p_1.png" } }),
      },
    ]);
    expect(await resolveUploadFile(strapi, "small_p_1.png")).toEqual({
      id: 3,
      names: ["p_1.png", "small_p_1.png"],
      uploadedBy: null,
    });
  });

  it("answers null for unknown names and nested paths without a lookup", async () => {
    const { strapi, findOne } = filesDb([IMAGE]);
    expect(await resolveUploadFile(strapi, "missing_000000.png")).toBeNull();
    findOne.mockClear();
    expect(await resolveUploadFile(strapi, "a/b.png")).toBeNull();
    expect(await resolveUploadFile(strapi, "")).toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });
});

describe("mayOpenUpload", () => {
  it("lets a moderator open every name without reading anything", async () => {
    const { strapi, findOne } = filesDb([]);
    expect(await mayOpenUpload(strapi, { id: 1, role: { type: "editor" } }, "x_1.pdf")).toBe(true);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("refuses a name no file has", async () => {
    const { strapi } = filesDb([]);
    expect(await mayOpenUpload(strapi, { id: 1, role: { type: "member" } }, "x_1.pdf")).toBe(false);
  });
});

describe("the controller's web-server check", () => {
  it("needs the configured secret", () => {
    const env = { INTERNAL_UPLOAD_TOKEN: "s3cret", NODE_ENV: "production" };
    expect(fromWebServer("s3cret", env)).toBe(true);
    expect(fromWebServer("wrong", env)).toBe(false);
    expect(fromWebServer("", env)).toBe(false);
  });

  it("without a configured secret: open in development, closed in production", () => {
    expect(fromWebServer("", { NODE_ENV: "development" })).toBe(true);
    expect(fromWebServer("anything", { NODE_ENV: "production" })).toBe(false);
  });
});
