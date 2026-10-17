import { errors } from "@strapi/utils";
import { describe, expect, it } from "vitest";
import {
  ADMIN,
  ENG,
  HEAD,
  LEAD,
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
    "refuses structural %s for every class",
    async (key) => {
      const { host } = world();
      for (const caller of [ADMIN, LEAD, HEAD])
        await expect(
          canEditTeam(context(caller, PLATFORM.documentId, { [key]: null }).ctx, undefined, {
            strapi: host,
          }),
        ).rejects.toMatchObject({ details: { keys: [key] } });
    },
  );
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
