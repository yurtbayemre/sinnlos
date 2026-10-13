/**
 * Content Manager writes on the content types hidden from the admin panel
 * (`pluginOptions["content-manager"].visible: false`: wiki-revision since
 * batch 15.1, content-version) are removed from every admin role at every
 * boot. Read stays.
 *
 * Why: for a hidden type the Content Manager registers `explorer.read` but
 * not create, update, delete and publish (@strapi/content-manager 5.57
 * services/permission.js registerPermissions), and the admin's own boot
 * cleanup is meant to delete a role's grants whose subject is no longer
 * registered for their action (@strapi/admin 5.57 services/permission/
 * queries.js cleanPermissionsInDatabase). That cleanup reads 200 rows per
 * page by OFFSET, without an order, and deletes each page's rows before it
 * reads the next, so with more than 200 admin permission rows it can skip
 * some; a skipped row still authorizes its action, which stays registered
 * for the other types. Without this step an admin role could keep editing
 * or deleting wiki revisions in the panel after the upgrade (Codex
 * re-review of plan 16-0). Super admins are reset to the registered
 * actions by Strapi at every boot.
 *
 * Deletes through the admin permission service (`deleteByIds`, the call
 * Strapi's cleanup makes), so the role links go with the rows and the
 * `permission.delete` event fires. Throws when that service is gone after a
 * Strapi upgrade, like the relation guard: the boot must not go on with
 * the panel open.
 */

export const ADMIN_PERMISSION_UID = "admin::permission";

/** The Content Manager actions a hidden type loses (read is not among them). */
export const HIDDEN_TYPE_WRITE_ACTIONS = [
  "plugin::content-manager.explorer.create",
  "plugin::content-manager.explorer.update",
  "plugin::content-manager.explorer.delete",
  "plugin::content-manager.explorer.publish",
] as const;

interface ContentTypeOptions {
  pluginOptions?: { "content-manager"?: { visible?: unknown } };
}

/** The slice of the Strapi instance this step touches. */
export interface HiddenTypePermissionsHost {
  contentTypes: Record<string, ContentTypeOptions | undefined>;
  db: {
    query(uid: string): {
      findMany(params: Record<string, unknown>): Promise<{ id: number; subject?: unknown }[]>;
    };
  };
  admin?: { services?: { permission?: { deleteByIds?: (ids: number[]) => Promise<unknown> } } };
  log: { info(message: string): void };
}

/** The api:: content types the Content Manager does not display, sorted. */
export function hiddenContentTypeUids(
  contentTypes: HiddenTypePermissionsHost["contentTypes"],
): string[] {
  return Object.entries(contentTypes)
    .filter(
      ([uid, type]) =>
        uid.startsWith("api::") && type?.pluginOptions?.["content-manager"]?.visible === false,
    )
    .map(([uid]) => uid)
    .sort();
}

export async function removeHiddenTypeWritePermissions(
  strapi: HiddenTypePermissionsHost,
): Promise<void> {
  const permissions = strapi.admin?.services?.permission;
  if (typeof permissions?.deleteByIds !== "function") {
    throw new Error(
      "[admin-permissions] strapi.admin.services.permission.deleteByIds not found — refusing to boot without removing the panel's writes on hidden types",
    );
  }
  const subjects = hiddenContentTypeUids(strapi.contentTypes);
  if (subjects.length === 0) return;
  const rows = await strapi.db.query(ADMIN_PERMISSION_UID).findMany({
    select: ["id", "subject"],
    where: { subject: { $in: subjects }, action: { $in: [...HIDDEN_TYPE_WRITE_ACTIONS] } },
  });
  if (rows.length === 0) return;
  await permissions.deleteByIds(rows.map((row) => row.id));
  const removedFrom = [...new Set(rows.map((row) => String(row.subject)))].sort();
  strapi.log.info(
    `[admin-permissions] removed ${rows.length} Content Manager write permission(s) on hidden types: ${removedFrom.join(", ")}`,
  );
}
