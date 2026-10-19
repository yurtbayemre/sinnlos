import { describe, expect, it } from "vitest";
import { registerMediaTombstoneGuard } from "./media-tombstone-guard";

const USER = "plugin::users-permissions.user";
const FILE = "plugin::upload.file";

/** A Strapi stand-in that records which rows get locked, in order. */
function fakeStrapi(file: Record<string, unknown> | null) {
  const locks: string[] = [];
  const subscribers: any[] = [];
  const strapi = {
    contentTypes: {
      [USER]: { attributes: { avatar: { type: "media" }, username: { type: "string" } } },
      "api::document.document": { attributes: { file: { type: "media" } } },
      "api::classified.classified": { attributes: { images: { type: "media" } } },
    },
    db: {
      lifecycles: { subscribe: (subscriber: unknown) => subscribers.push(subscriber) },
      queryBuilder: (uid: string) => {
        const builder: any = {
          select: () => builder,
          where: () => builder,
          forUpdate: () => builder,
          execute: async () => {
            locks.push(uid);
            return [];
          },
        };
        return builder;
      },
      query: () => ({ findOne: async () => file, findMany: async () => [] }),
    },
  };
  registerMediaTombstoneGuard(strapi);
  return { locks, subscriber: subscribers[0] };
}

describe("media tombstone guard", () => {
  it("guards only the media fields without their own claim (the avatar)", () => {
    expect(fakeStrapi(null).subscriber.models).toEqual([USER]);
  });

  it("locks the written row before the files and refuses a tombstoned file with the field's key", async () => {
    const { locks, subscriber } = fakeStrapi({
      id: 7,
      provider_metadata: { removing: "2026-10-19T20:00:00Z" },
    });
    await expect(
      subscriber.beforeUpdate({
        model: { uid: USER },
        params: { where: { id: 3 }, data: { avatar: 7 } },
      }),
    ).rejects.toMatchObject({ details: { keys: ["avatar"] } });
    expect(locks).toEqual([USER, FILE]);
  });

  it("lets a live file and a write without the field through", async () => {
    const { locks, subscriber } = fakeStrapi({ id: 7, provider_metadata: null });
    await subscriber.beforeUpdate({
      model: { uid: USER },
      params: { where: { id: 3 }, data: { avatar: 7 } },
    });
    await subscriber.beforeUpdate({
      model: { uid: USER },
      params: { where: { id: 3 }, data: { username: "x" } },
    });
    expect(locks).toEqual([USER, FILE]);
  });
});
