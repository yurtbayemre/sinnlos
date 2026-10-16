import { errors } from "@strapi/utils";
import { describe, expect, it, vi } from "vitest";
import { CONTENT_VERSION_UID, ClassLost, RevisionStale, getAuthoringScope } from "./document-lock";
import { orgAuthoringActions, orgGate } from "./org-authoring";
import {
  ADMIN,
  DEPT,
  ENG,
  HEAD,
  LEAD,
  PLATFORM,
  TEAM,
  context,
  world,
} from "./org-authoring.test.helper";

for (const [uid, target, caller] of [
  [DEPT, ENG, HEAD],
  [TEAM, PLATFORM, LEAD],
] as const) {
  describe(`${uid} fixed org authoring responses`, () => {
    it.each([null, "2026-01-01T00:00:00Z"])(
      "reads a single row with publishedAt=%s and version before content",
      async (publishedAt) => {
        const { host, strapi } = world();
        strapi.tables[uid][0].publishedAt = publishedAt;
        const { ctx, headers } = context(caller, target.documentId);
        expect(await orgGate(uid)(ctx, { intent: "editable" }, { strapi: host })).toBe(true);
        await orgAuthoringActions(host, uid).editable(ctx);
        expect(headers.ETag).toBe('"7"');
        expect(ctx.body).toMatchObject({
          data: {
            documentId: target.documentId,
            version: "7",
            roleClass: uid === DEPT ? "departmentHead" : "teamLead",
          },
        });
        const data = (ctx.body as { data: object }).data;
        for (const key of [
          "id",
          "publishedAt",
          "status",
          "head",
          "lead",
          "members",
          "department",
          "headerImage",
          "avatar",
        ])
          expect(data).not.toHaveProperty(key);
        const reads = strapi.calls.map((call) => call.uid);
        expect(reads.indexOf(CONTENT_VERSION_UID)).toBeLessThan(reads.indexOf(uid));
      },
    );
    it("admin gets only the type's media, not any private uploader data", async () => {
      const { host, strapi } = world();
      const field = uid === DEPT ? "headerImage" : "avatar";
      strapi.tables[uid][0][field] = {
        id: 6,
        name: "Image",
        mime: "image/png",
        size: 1,
        url: "/uploads/a.png",
        provider_metadata: { uploadedBy: 99 },
      };
      const { ctx } = context(ADMIN, target.documentId);
      await orgGate(uid)(ctx, { intent: "editable" }, { strapi: host });
      await orgAuthoringActions(host, uid).editable(ctx);
      expect((ctx.body as { data: Record<string, unknown> }).data[field]).toEqual({
        id: 6,
        name: "Image",
        mime: "image/png",
        size: 1,
        url: "/uploads/a.png",
      });
    });
    it("sends a status-free write through the existing scope and returns the committed revision", async () => {
      const { host, strapi } = world();
      const { ctx, headers } = context(caller, String(target.id));
      await orgGate(uid)(ctx, undefined, { strapi: host });
      const update = vi.fn(async (params: unknown) => {
        expect(params).toEqual({ documentId: target.documentId, data: { description: "Updated" } });
        const scope = getAuthoringScope()!;
        expect(scope).toMatchObject({
          uid,
          documentId: target.documentId,
          expectedRevision: 7,
          observedRevision: 7,
          missingClass: 403,
          source: "content-api",
        });
        expect(await scope.classify!({ uid, documentId: target.documentId })).toBe(
          uid === DEPT ? "departmentHead" : "teamLead",
        );
        scope.committedRevision = 8;
      });
      strapi.documents = vi.fn(() => ({ update })) as never;
      await orgAuthoringActions(host, uid).update(ctx);
      expect(ctx.status).toBe(200);
      expect(ctx.body).toEqual({ data: { documentId: target.documentId, version: "8" } });
      expect(headers.ETag).toBe('"8"');
    });
    it("requires If-Match and maps stale/lost-access refusals without leaking a new version", async () => {
      const { host, strapi } = world();
      const { ctx } = context(caller, target.documentId);
      await orgGate(uid)(ctx, undefined, { strapi: host });
      ctx.get = () => "";
      await orgAuthoringActions(host, uid).update(ctx);
      expect(ctx.status).toBe(428);
      expect(strapi.calls.filter((call) => call.api === "documents")).toEqual([]);
      ctx.get = () => '"7"';
      for (const error of [new RevisionStale(8), new ClassLost(403)]) {
        strapi.documents = (() => ({
          update: async () => {
            throw error;
          },
        })) as never;
        await orgAuthoringActions(host, uid).update(ctx);
        expect(ctx.status).toBe(error.status);
        expect((ctx.body as { error: { details: object } }).error.details).toEqual(
          error instanceof RevisionStale ? { current: 8 } : {},
        );
      }
    });
    it("controller rechecks query closure even after a gate decision", async () => {
      const { host } = world();
      const { ctx } = context(caller, target.documentId);
      await orgGate(uid)(ctx, undefined, { strapi: host });
      ctx.query = { status: "published" };
      await expect(orgAuthoringActions(host, uid).update(ctx)).rejects.toBeInstanceOf(
        errors.ValidationError,
      );
    });
  });
}
