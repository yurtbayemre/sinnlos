import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_KUDOS_MESSAGE } from "@sinnlos/domain";

import { createTestStrapi, testEngines, type TestStrapi } from "./harness.test.helper";

/**
 * v0.32 (#198): a kudos message has at most MAX_KUDOS_MESSAGE characters,
 * over real HTTP against the running cms. One more is refused whole (400,
 * `details.code` `message`) and nothing is stored.
 */

describe.each(testEngines())("the kudos message limit on %s", (engine) => {
  let t: TestStrapi;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
  });

  afterAll(async () => {
    await t?.stop();
  });

  const send = (message: string) =>
    t.api<{ error?: { details?: { code?: string } } }>("member", "/api/kudos-entries", {
      json: { data: { to: t.fixtures.users.editor.id, message, value: "teamwork" } },
    });
  const stored = (message: string) =>
    t.strapi.db.query("api::kudos.kudos").count({ where: { message } });

  it("stores a message of exactly the limit", async () => {
    const message = "a".repeat(MAX_KUDOS_MESSAGE);
    const answer = await send(message);
    expect(answer.status, JSON.stringify(answer.body)).toBe(201);
    expect(await stored(message)).toBe(1);
  });

  it("refuses one character more, stores nothing and cuts nothing", async () => {
    const message = "b".repeat(MAX_KUDOS_MESSAGE + 1);
    const answer = await send(message);
    expect(answer.status).toBe(400);
    expect(answer.body.error?.details?.code).toBe("message");
    expect(await stored(message)).toBe(0);
    expect(await stored(message.slice(0, MAX_KUDOS_MESSAGE))).toBe(0);
  });
});
