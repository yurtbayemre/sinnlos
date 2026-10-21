import { describe, expect, it, vi } from "vitest";
import controllerFactory from "./team";

vi.mock("@strapi/strapi", () => ({
  factories: {
    createCoreController: (_uid: string, cfg: (deps: { strapi: unknown }) => object) => cfg,
  },
}));

describe("team authoring controller wiring", () => {
  it("overrides create, editable, update and delete and fails closed without a gate decision", async () => {
    const controller = (
      controllerFactory as unknown as (deps: {
        strapi: unknown;
      }) => Record<string, (ctx: unknown) => Promise<void>>
    )({ strapi: {} });
    expect(Object.keys(controller).sort()).toEqual(["create", "delete", "editable", "update"]);
    for (const action of Object.values(controller))
      await expect(action({ state: {} })).rejects.toMatchObject({ name: "ForbiddenError" });
  });
});
