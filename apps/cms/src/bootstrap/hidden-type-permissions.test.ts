import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ADMIN_PERMISSION_UID,
  HIDDEN_TYPE_WRITE_ACTIONS,
  hiddenContentTypeUids,
  removeHiddenTypeWritePermissions,
  type HiddenTypePermissionsHost,
} from "./hidden-type-permissions";

/**
 * The boot step that takes Content Manager writes on hidden types away from
 * every admin role (batch 15.1). The real admin permission service and
 * Strapi's own cleanup run in
 * integration/wiki-revisions-closed.integration.test.ts on both engines.
 */

const REVISION = "api::wiki-revision.wiki-revision";
const PAGE = "api::wiki-page.wiki-page";
const VERSION = "api::content-version.content-version";
const HIDDEN = { pluginOptions: { "content-manager": { visible: false } } };

interface Row {
  id: number;
  action: string;
  subject: string;
}

function host(rows: Row[], options: { deleteByIds?: unknown } = {}) {
  const deleted: number[][] = [];
  const findMany = vi.fn(async (params: Record<string, unknown>) => {
    const where = params.where as { subject: { $in: string[] }; action: { $in: string[] } };
    return rows
      .filter((row) => where.subject.$in.includes(row.subject))
      .filter((row) => where.action.$in.includes(row.action))
      .map(({ id, subject }) => ({ id, subject }));
  });
  const info = vi.fn();
  const strapi: HiddenTypePermissionsHost = {
    contentTypes: { [REVISION]: HIDDEN, [VERSION]: HIDDEN, [PAGE]: {} },
    db: {
      query: (uid: string) => {
        expect(uid).toBe(ADMIN_PERMISSION_UID);
        return { findMany };
      },
    },
    admin: {
      services: {
        permission: {
          deleteByIds:
            "deleteByIds" in options
              ? options.deleteByIds
              : async (ids: number[]) => {
                  deleted.push(ids);
                },
        },
      },
    },
    log: { info },
  };
  return { strapi, deleted, info, findMany };
}

const row = (id: number, action: string, subject: string): Row => ({
  id,
  action: `plugin::content-manager.explorer.${action}`,
  subject,
});

describe("hiddenContentTypeUids", () => {
  it("lists the api:: types the Content Manager does not display", () => {
    expect(
      hiddenContentTypeUids({
        [PAGE]: {},
        [REVISION]: HIDDEN,
        [VERSION]: HIDDEN,
        "plugin::upload.file": HIDDEN,
        "api::x.x": { pluginOptions: { "content-manager": { visible: true } } },
        "api::y.y": undefined,
      }),
    ).toEqual([VERSION, REVISION]);
  });

  it("covers exactly the cms schemas that hide themselves: wiki-revision and content-version", () => {
    const apiDir = join(__dirname, "..", "api");
    const contentTypes: HiddenTypePermissionsHost["contentTypes"] = {};
    for (const api of readdirSync(apiDir)) {
      let names: string[] = [];
      try {
        names = readdirSync(join(apiDir, api, "content-types"));
      } catch {
        continue;
      }
      for (const name of names) {
        const file = join(apiDir, api, "content-types", name, "schema.json");
        contentTypes[`api::${api}.${name}`] = JSON.parse(readFileSync(file, "utf8"));
      }
    }
    expect(hiddenContentTypeUids(contentTypes)).toEqual([VERSION, REVISION]);
  });
});

describe("removeHiddenTypeWritePermissions", () => {
  it("removes every Content Manager write on a hidden type, of any role, and keeps read", async () => {
    const rows = [
      row(1, "create", REVISION),
      row(2, "read", REVISION),
      row(3, "update", REVISION),
      row(4, "delete", REVISION),
      row(5, "publish", REVISION),
      row(6, "update", PAGE),
      row(7, "delete", VERSION),
      { id: 8, action: "plugin::upload.read", subject: REVISION },
    ];
    const { strapi, deleted, info } = host(rows);
    await removeHiddenTypeWritePermissions(strapi);
    expect(deleted).toEqual([[1, 3, 4, 5, 7]]);
    expect(info).toHaveBeenCalledWith(
      `[admin-permissions] removed 5 Content Manager write permission(s) on hidden types: ${VERSION}, ${REVISION}`,
    );
  });

  it("asks for the four write actions only", async () => {
    const { strapi, findMany } = host([]);
    await removeHiddenTypeWritePermissions(strapi);
    expect(findMany).toHaveBeenCalledWith({
      select: ["id", "subject"],
      where: {
        subject: { $in: [VERSION, REVISION] },
        action: { $in: [...HIDDEN_TYPE_WRITE_ACTIONS] },
      },
    });
    expect(HIDDEN_TYPE_WRITE_ACTIONS.some((action) => action.endsWith(".read"))).toBe(false);
  });

  it("deletes nothing and logs nothing on a database without such rows (every later boot)", async () => {
    const { strapi, deleted, info } = host([row(2, "read", REVISION), row(6, "update", PAGE)]);
    await removeHiddenTypeWritePermissions(strapi);
    expect(deleted).toEqual([]);
    expect(info).not.toHaveBeenCalled();
  });

  it("refuses to boot when the admin permission service is gone", async () => {
    const { strapi } = host([row(1, "create", REVISION)], { deleteByIds: undefined });
    await expect(removeHiddenTypeWritePermissions(strapi)).rejects.toThrow(/deleteByIds not found/);
    await expect(removeHiddenTypeWritePermissions({ ...strapi, admin: undefined })).rejects.toThrow(
      /\[admin-permissions\]/,
    );
  });
});
