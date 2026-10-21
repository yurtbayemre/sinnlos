import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";
import {
  ADMIN,
  ENG,
  HEAD,
  HEAD_USER_DOC,
  LEAD,
  LEAD_USER_DOC,
  PLATFORM,
  SALES,
  TEAM,
  USER,
  context,
  world,
} from "../utils/org-authoring.test.helper";
import canEditTeam from "./can-edit-team";

describe("team single-row gate", () => {
  it.each([PLATFORM.documentId, String(PLATFORM.id)])(
    "admits the lead and own department head: %s",
    async (id) => {
      const { host } = world();
      for (const caller of [LEAD, HEAD, ADMIN])
        expect(await canEditTeam(context(caller, id).ctx, undefined, { strapi: host })).toBe(true);
    },
  );
  it("keeps lead precedence for a granted head who leads a team in another department", async () => {
    const { host, strapi } = world();
    strapi.tables[TEAM][0].lead = { id: HEAD.id };
    strapi.tables[TEAM][0].department = { id: SALES.id };
    const { ctx } = context(HEAD, PLATFORM.documentId);
    expect(await canEditTeam(ctx, undefined, { strapi: host })).toBe(true);
    expect(ctx.state.orgAuthoring).toMatchObject({ roleClass: "teamLead" });
  });
  it.each(["editor", "member", "guest", "authenticated"])(
    "never grants %s through a stored lead relation",
    async (type) => {
      const { host } = world();
      expect(
        await canEditTeam(
          context({ ...LEAD, role: { type } }, PLATFORM.documentId).ctx,
          undefined,
          { strapi: host },
        ),
      ).toBe(false);
    },
  );
  it("a plain member or another department's head gets no row class", async () => {
    const { host, strapi } = world();
    strapi.tables[TEAM][0].members = [{ id: 99 }];
    expect(
      await canEditTeam(
        context({ id: 99, role: { type: "team_lead" } }, PLATFORM.documentId).ctx,
        undefined,
        { strapi: host },
      ),
    ).toBe(false);
    strapi.tables[USER][0].department = { id: SALES.id };
    const { ctx } = context(HEAD, PLATFORM.documentId);
    expect(await canEditTeam(ctx, undefined, { strapi: host })).toBe(false);
    await expect(canEditTeam(ctx, { intent: "editable" }, { strapi: host })).rejects.toBeInstanceOf(
      errors.NotFoundError,
    );
  });
  it("an orphan team cannot match a head without a department", async () => {
    const { host, strapi } = world();
    strapi.tables[TEAM][0].department = null;
    strapi.tables[USER][0].department = null;
    expect(
      await canEditTeam(context(HEAD, PLATFORM.documentId).ctx, undefined, { strapi: host }),
    ).toBe(false);
  });
  it.each(["name", "slug", "lead", "members", "department", "pages"])(
    "refuses structural %s for leads and heads",
    async (key) => {
      const { host } = world();
      for (const caller of [LEAD, HEAD])
        await expect(
          canEditTeam(context(caller, PLATFORM.documentId, { [key]: null }).ctx, undefined, {
            strapi: host,
          }),
        ).rejects.toMatchObject({ details: { keys: [key] } });
    },
  );
  it.each(["slug", "pages"])("refuses derived and inverse %s even for admin", async (key) => {
    const { host } = world();
    await expect(
      canEditTeam(context(ADMIN, PLATFORM.documentId, { [key]: null }).ctx, undefined, {
        strapi: host,
      }),
    ).rejects.toMatchObject({ details: { keys: [key] } });
  });
  it("lets admin_role rename, move, set the lead and change the members (v0.22)", async () => {
    const { host } = world();
    const { ctx } = context(ADMIN, PLATFORM.documentId, {
      name: "Plattform",
      department: SALES.documentId,
      lead: HEAD_USER_DOC,
      members: { connect: [LEAD_USER_DOC, HEAD_USER_DOC, LEAD_USER_DOC], disconnect: [] },
    });
    expect(await canEditTeam(ctx, undefined, { strapi: host })).toBe(true);
    expect(ctx.request.body).toEqual({
      data: {
        name: "Plattform",
        department: { set: [{ documentId: SALES.documentId }] },
        lead: { set: [{ documentId: HEAD_USER_DOC }] },
        members: {
          connect: [{ documentId: LEAD_USER_DOC }, { documentId: HEAD_USER_DOC }],
          disconnect: [],
        },
      },
    });
    await expect(
      canEditTeam(
        context(ADMIN, PLATFORM.documentId, {
          members: { connect: ["unknown0000000000000000000"] },
        }).ctx,
        undefined,
        { strapi: host },
      ),
    ).rejects.toMatchObject({ details: { keys: ["members"] } });
    // Changes only (Codex v0.22): a full list, a set and a target on both sides are refused.
    for (const members of [
      [LEAD_USER_DOC],
      { set: [LEAD_USER_DOC] },
      { connect: [LEAD_USER_DOC], disconnect: [LEAD_USER_DOC] },
      {},
    ])
      await expect(
        canEditTeam(context(ADMIN, PLATFORM.documentId, { members }).ctx, undefined, {
          strapi: host,
        }),
      ).rejects.toMatchObject({ details: { keys: ["members"] } });
  });
  it("create: admin_role only, needs a department, slug derived", async () => {
    const { host } = world();
    const { ctx } = context(ADMIN, undefined, { name: "Lager", department: ENG.documentId });
    expect(await canEditTeam(ctx, { intent: "create" }, { strapi: host })).toBe(true);
    expect((ctx.request.body as { data: { slug: string } }).data.slug).toMatch(
      /^lager-[0-9a-f]{8}$/,
    );
    await expect(
      canEditTeam(
        context(ADMIN, undefined, { name: "Lager" }).ctx,
        { intent: "create" },
        {
          strapi: host,
        },
      ),
    ).rejects.toMatchObject({ details: { keys: ["department"] } });
    for (const caller of [LEAD, HEAD])
      expect(
        await canEditTeam(
          context(caller, undefined, { name: "Lager", department: ENG.documentId }).ctx,
          { intent: "create" },
          { strapi: host },
        ),
      ).toBe(false);
  });
  it("delete: admin_role only", async () => {
    const { host } = world();
    expect(
      await canEditTeam(
        context(ADMIN, PLATFORM.documentId).ctx,
        { intent: "delete" },
        {
          strapi: host,
        },
      ),
    ).toBe(true);
    for (const caller of [LEAD, HEAD])
      expect(
        await canEditTeam(
          context(caller, PLATFORM.documentId).ctx,
          { intent: "delete" },
          {
            strapi: host,
          },
        ),
      ).toBe(false);
  });
  it("heads and leads cannot attach or clear the avatar", async () => {
    const { host } = world();
    for (const caller of [LEAD, HEAD])
      await expect(
        canEditTeam(context(caller, PLATFORM.documentId, { avatar: null }).ctx, undefined, {
          strapi: host,
        }),
      ).rejects.toMatchObject({ details: { keys: ["avatar"] } });
  });
  it("reclassifies a changed team under the lock, including a lost lead", async () => {
    const { host, strapi } = world();
    const { ctx } = context(LEAD, PLATFORM.documentId);
    expect(await canEditTeam(ctx, undefined, { strapi: host })).toBe(true);
    const gate = ctx.state.orgAuthoring as {
      classify(target: { uid: string; documentId: string }): Promise<string | null>;
    };
    const target = { uid: TEAM, documentId: PLATFORM.documentId };
    expect(await gate.classify(target)).toBe("teamLead");
    strapi.tables[TEAM][0].lead = null;
    expect(await gate.classify(target)).toBeNull();
    strapi.tables[TEAM][0].department = { id: ENG.id };
  });
});
