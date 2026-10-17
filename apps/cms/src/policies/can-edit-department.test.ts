import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";
import { MALFORMED_ENTRY_IDS } from "../utils/entry-id.test.helper";
import {
  ADMIN,
  DEPT,
  ENG,
  HEAD,
  SALES,
  USER,
  context,
  world,
} from "../utils/org-authoring.test.helper";
import canEditDepartment from "./can-edit-department";

describe("department single-row gate", () => {
  it.each([ENG.documentId, String(ENG.id)])(
    "allows own heads with canonical and numeric ids: %s",
    async (id) => {
      const { host } = world();
      const { ctx } = context(HEAD, id, { description: null, color: "#abcdef" });
      expect(await canEditDepartment(ctx, undefined, { strapi: host })).toBe(true);
      expect(ctx.request.body).toEqual({ data: { description: null, color: "#abcdef" } });
      expect(ctx.request.query).toEqual({});
    },
  );
  it("uses user.department, not the department's display head relation", async () => {
    const { host, strapi } = world();
    strapi.tables[DEPT][0].head = { id: HEAD.id };
    strapi.tables[USER][0].department = { id: SALES.id };
    const { ctx } = context(HEAD, ENG.documentId, { name: "Forbidden" });
    expect(await canEditDepartment(ctx, undefined, { strapi: host })).toBe(false);
    await expect(
      canEditDepartment(ctx, { intent: "editable" }, { strapi: host }),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
  });
  it.each(["editor", "team_lead", "member", "guest", "authenticated"])(
    "refuses %s even with a matching department",
    async (type) => {
      const { host } = world();
      expect(
        await canEditDepartment(
          context({ ...HEAD, role: { type } }, ENG.documentId).ctx,
          undefined,
          { strapi: host },
        ),
      ).toBe(false);
    },
  );
  it("refuses missing callers and malformed ids before querying", async () => {
    const { host, strapi } = world();
    for (const id of [undefined, ...MALFORMED_ENTRY_IDS])
      expect(await canEditDepartment(context(HEAD, id).ctx, undefined, { strapi: host })).toBe(
        false,
      );
    expect(
      await canEditDepartment(context(null, ENG.documentId).ctx, undefined, { strapi: host }),
    ).toBe(false);
    expect(strapi.calls).toEqual([]);
  });
  it.each(["name", "slug", "head", "members", "teams", "pages", "publishedAt", "documentId"])(
    "refuses structural %s even for admin",
    async (key) => {
      const { host } = world();
      for (const caller of [ADMIN, HEAD])
        await expect(
          canEditDepartment(context(caller, ENG.documentId, { [key]: null }).ctx, undefined, {
            strapi: host,
          }),
        ).rejects.toMatchObject({ details: { keys: [key] } });
    },
  );
  it("heads cannot write media or malformed description/color", async () => {
    const { host } = world();
    for (const data of [{ headerImage: null }, { description: {} }, { color: "red" }])
      await expect(
        canEditDepartment(context(HEAD, ENG.documentId, data).ctx, undefined, { strapi: host }),
      ).rejects.toBeInstanceOf(errors.ValidationError);
  });
  it.each(["status", "populate", "fields", "filters", "sort"])(
    "rejects every %s query key instead of pinning status",
    async (key) => {
      const { host } = world();
      for (const caller of [ADMIN, HEAD])
        for (const intent of ["update", "editable"])
          await expect(
            canEditDepartment(
              context(caller, ENG.documentId, {}, { [key]: "published" }).ctx,
              { intent },
              { strapi: host },
            ),
          ).rejects.toMatchObject({ details: { keys: [key] } });
    },
  );
});
