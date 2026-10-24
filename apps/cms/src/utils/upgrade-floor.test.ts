import { describe, expect, it } from "vitest";

import { UPGRADE_FLOOR_MESSAGE, assertUpgradeFloor } from "./upgrade-floor";

/**
 * The upgrade floor guard with the two schema-builder calls of
 * @strapi/database stubbed (getSchemaConnection().hasTable/hasColumn). The
 * real database is covered by integration/upgrade-floor.integration.test.ts.
 */
function host(table: boolean, column: boolean) {
  const calls: string[] = [];
  return {
    calls,
    strapi: {
      db: {
        getSchemaConnection: () => ({
          hasTable: async (name: string) => {
            calls.push(`table ${name}`);
            return table;
          },
          hasColumn: async (name: string, col: string) => {
            calls.push(`column ${name}.${col}`);
            return column;
          },
        }),
      },
    },
  };
}

describe("upgrade floor guard (v0.29)", () => {
  it("lets a fresh database through (no up_users yet)", async () => {
    const { strapi, calls } = host(false, false);
    await expect(assertUpgradeFloor(strapi)).resolves.toBeUndefined();
    expect(calls).toEqual(["table up_users"]);
  });

  it("lets a v0.25+ database through", async () => {
    const { strapi, calls } = host(true, true);
    await expect(assertUpgradeFloor(strapi)).resolves.toBeUndefined();
    expect(calls).toEqual(["table up_users", "column up_users.oidc_subject"]);
  });

  it("refuses an up_users without oidc_subject, naming the way through v0.28.x", async () => {
    await expect(assertUpgradeFloor(host(true, false).strapi)).rejects.toThrow(
      UPGRADE_FLOOR_MESSAGE,
    );
    expect(UPGRADE_FLOOR_MESSAGE).toMatch(/upgrade to v0\.28\.x first.*docs\/UPGRADE\.md/);
  });
});
