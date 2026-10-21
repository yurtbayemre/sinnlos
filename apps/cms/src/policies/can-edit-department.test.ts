import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";
import { MALFORMED_ENTRY_IDS } from "../utils/entry-id.test.helper";
import {
  ADMIN,
  DEPT,
  ENG,
  HEAD,
  HEAD_USER_DOC,
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
  it.each(["slug", "members", "teams", "pages", "publishedAt", "documentId"])(
    "refuses derived and inverse %s even for admin",
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
  it.each(["name", "head"])("refuses structural %s for a head", async (key) => {
    const { host } = world();
    await expect(
      canEditDepartment(context(HEAD, ENG.documentId, { [key]: null }).ctx, undefined, {
        strapi: host,
      }),
    ).rejects.toMatchObject({ details: { keys: [key] } });
  });
  it("lets admin_role rename and set the display head (v0.22)", async () => {
    const { host } = world();
    const { ctx } = context(ADMIN, ENG.documentId, { name: "Technik", head: HEAD_USER_DOC });
    expect(await canEditDepartment(ctx, undefined, { strapi: host })).toBe(true);
    expect(ctx.request.body).toEqual({
      data: { name: "Technik", head: { set: [{ documentId: HEAD_USER_DOC }] } },
    });
    const cleared = context(ADMIN, ENG.documentId, { head: null }).ctx;
    expect(await canEditDepartment(cleared, undefined, { strapi: host })).toBe(true);
    await expect(
      canEditDepartment(
        context(ADMIN, ENG.documentId, { head: "unknown0000000000000000000" }).ctx,
        undefined,
        { strapi: host },
      ),
    ).rejects.toMatchObject({ details: { keys: ["head"] } });
  });
  it("create: admin_role only, slug derived from the name", async () => {
    const { host } = world();
    const { ctx } = context(ADMIN, undefined, { name: "Logistik", color: "#00aa00" });
    expect(await canEditDepartment(ctx, { intent: "create" }, { strapi: host })).toBe(true);
    const data = (ctx.request.body as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ name: "Logistik", color: "#00aa00" });
    expect(data.slug).toMatch(/^logistik-[0-9a-f]{8}$/);
    for (const caller of [HEAD, { ...HEAD, role: { type: "editor" } }])
      expect(
        await canEditDepartment(
          context(caller, undefined, { name: "X" }).ctx,
          { intent: "create" },
          {
            strapi: host,
          },
        ),
      ).toBe(false);
    await expect(
      canEditDepartment(
        context(ADMIN, undefined, { name: "X", slug: "x" }).ctx,
        {
          intent: "create",
        },
        { strapi: host },
      ),
    ).rejects.toMatchObject({ details: { keys: ["slug"] } });
  });
  it("delete: admin_role only; an unknown department is a 404", async () => {
    const { host } = world();
    const { ctx } = context(ADMIN, ENG.documentId, undefined);
    expect(await canEditDepartment(ctx, { intent: "delete" }, { strapi: host })).toBe(true);
    expect(ctx.state.orgAuthoring).toMatchObject({ intent: "delete", roleClass: "moderator" });
    expect(
      await canEditDepartment(
        context(HEAD, ENG.documentId).ctx,
        { intent: "delete" },
        {
          strapi: host,
        },
      ),
    ).toBe(false);
    await expect(
      canEditDepartment(
        context(ADMIN, "dmissing0000000000000000").ctx,
        { intent: "delete" },
        {
          strapi: host,
        },
      ),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
  });
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
