/**
 * Secret shares never open in the admin panel (v0.35.0, plan §3.6), whatever
 * a role is granted there later: there is no admin view of shares.
 *
 *   - The Content Manager's `permission-checker` service is the one place
 *     every Content Manager route asks before it touches a type: the
 *     collection and detail routes, bulk actions, relations, history (whose
 *     uid comes in the query string), the i18n fill-from-locale route and
 *     the review-workflow entries, including callers that only use its
 *     sanitizers (@strapi/content-manager 5.60 controllers/*, history/*).
 *     Its `create({ model })` factory is wrapped here and throws a
 *     ForbiddenError at once for the secret-share uid: an immediate refusal
 *     before any read or write, not a sanitizer that could come after one.
 *   - The preview URL route does not use the checker
 *     (preview/controllers/preview.js), so the preview service refuses the
 *     uid too.
 *   - Releases refuse a type without draft & publish already.
 * The boot also removes every Content Manager grant on the uid from every
 * admin role (bootstrap/hidden-type-permissions.ts). Schema secrecy is no
 * goal: the panel's init and content-type endpoints still describe the
 * type, never its rows.
 *
 * register(): throws when a service is gone after a Strapi upgrade, like the
 * relation guard: the boot must not go on with the panel open.
 */
import { errors } from "@strapi/utils";

import { SECRET_SHARE_UID } from "../utils/secret-shares";

const WRAPPED = Symbol.for("sinnlos.secret-share.admin-closure");

type Service = Record<string | symbol, unknown>;

/** The slice of the Strapi instance this step touches. */
export interface AdminClosureHost {
  plugin(name: string): { service(name: string): unknown } | undefined;
}

const refuse = (): never => {
  throw new errors.ForbiddenError("Forbidden");
};

/** The model a permission-checker or preview call names, if any. */
const isSecretShare = (model: unknown) => model === SECRET_SHARE_UID;

export function closeSecretSharesInAdmin(strapi: AdminClosureHost): void {
  const plugin = strapi.plugin("content-manager");
  const checker = plugin?.service("permission-checker") as Service | undefined;
  const preview = plugin?.service("preview") as Service | undefined;
  if (typeof checker?.create !== "function" || typeof preview?.getPreviewUrl !== "function") {
    throw new Error(
      "[secrets] the Content Manager's permission-checker or preview service is missing — refusing to boot with secret shares open in the admin panel",
    );
  }
  if (checker[WRAPPED] && preview[WRAPPED]) return;
  const create = (checker.create as (params: { model?: unknown }) => unknown).bind(checker);
  checker.create = (params: { model?: unknown }) => {
    if (isSecretShare(params?.model)) refuse();
    return create(params);
  };
  checker[WRAPPED] = true;
  const getPreviewUrl = (preview.getPreviewUrl as (uid: unknown, params: unknown) => unknown).bind(
    preview,
  );
  preview.getPreviewUrl = (uid: unknown, params: unknown) => {
    if (isSecretShare(uid)) refuse();
    return getPreviewUrl(uid, params);
  };
  preview[WRAPPED] = true;
}
