/**
 * The admin panel's own API for the integration suites (batch 15 plan,
 * contract K5; ported from the v2 spike's spike-v2.test.helper.ts).
 *
 * The admin panel writes through the Content Manager (`/content-manager/
 * collection-types/:uid…`), which runs every write through the Document
 * Service (C19), so the app's Document Service middlewares see it. These
 * helpers send what the panel sends, with an admin JWT:
 *
 *   const t = await createTestStrapi({ engine, env: ADMIN_ENV });
 *   const panel = await contentManager(t);
 *   const { body } = await panel.create(UID, { title: "Draft" });
 *   await panel.publish(UID, body.data.documentId);
 *
 * SUPER ADMIN. `ADMIN_ENV` makes the real bootstrap's admin seed
 * (utils/admin-seed.ts) create a super admin on the suite's first boot;
 * `adminToken` signs in at POST /admin/login. A restart on the same
 * database keeps that admin (the seed only runs while none exists).
 *
 * MORE USERS. `createUser(t, role, department?)` adds an intranet user of
 * any role (a second department head, a moved head) through the
 * users-permissions user service, as the harness fixtures do;
 * `signIn(t, user)` returns its content-API JWT.
 *
 * Multipart (file uploads through the panel) is reserved for batch 16.
 *
 * Named *.test.helper.ts like harness.test.helper.ts: not a suite, not part
 * of the cms build.
 */
import { randomBytes } from "node:crypto";

import type { Row, TestRole, TestStrapi, TestUser } from "./harness.test.helper";

/** The super admin `ADMIN_ENV` seeds (the admin password policy: 8+, upper, lower, digit). */
export const ADMIN_CREDENTIALS = {
  email: "it-super-admin@integration.test",
  password: "ItSuperAdmin12345",
} as const;

/** Pass to createTestStrapi's `env` to seed the super admin. */
export const ADMIN_ENV: Readonly<Record<string, string>> = {
  STRAPI_ADMIN_EMAIL: ADMIN_CREDENTIALS.email,
  STRAPI_ADMIN_PASSWORD: ADMIN_CREDENTIALS.password,
};

export interface AdminResponse<T> {
  status: number;
  body: T;
  text: string;
}

/** POST /admin/login: the admin JWT (@strapi/admin authentication login). */
export async function adminToken(
  t: TestStrapi,
  email: string = ADMIN_CREDENTIALS.email,
  password: string = ADMIN_CREDENTIALS.password,
): Promise<string> {
  const res = await adminRequest<{ data?: { token?: unknown } }>(t, null, "/admin/login", {
    method: "POST",
    json: { email, password },
  });
  const token = res.body?.data?.token;
  if (res.status !== 200 || typeof token !== "string") {
    throw new Error(`[integration] admin login failed: ${res.status} ${res.text}`);
  }
  return token;
}

/** One request to the admin API, with the admin JWT when given. */
export async function adminRequest<T = unknown>(
  t: TestStrapi,
  token: string | null,
  path: string,
  init: { method?: string; json?: unknown } = {},
): Promise<AdminResponse<T>> {
  const res = await fetch(`${t.baseUrl}${path}`, {
    method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.json !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body: body as T, text };
}

/** The Content Manager path of a collection type, a document, or one of its actions. */
export const cmPath = (uid: string, documentId?: string, action?: string): string =>
  `/content-manager/collection-types/${uid}${documentId ? `/${documentId}` : ""}${
    action ? `/actions/${action}` : ""
  }`;

/** A Content Manager answer for one document: `{ data, meta }`. */
export interface CmDocument {
  data: Row & Record<string, unknown>;
  meta?: unknown;
  error?: { status: number; name: string; message: string; details?: Record<string, unknown> };
}

/** The Content Manager calls of the admin panel, as one admin. */
export interface ContentManager {
  readonly token: string;
  /** "Save" on a new entry: creates the draft. */
  create(uid: string, data: Record<string, unknown>): Promise<AdminResponse<CmDocument>>;
  /** "Publish" on a new entry: creates and publishes in one request. */
  createAndPublish(uid: string, data: Record<string, unknown>): Promise<AdminResponse<CmDocument>>;
  /** "Save" on an existing entry: updates the draft. */
  update(
    uid: string,
    documentId: string,
    data: Record<string, unknown>,
  ): Promise<AdminResponse<CmDocument>>;
  /** "Publish" on an existing entry: saves the form (`data`), then publishes. */
  publish(
    uid: string,
    documentId: string,
    data?: Record<string, unknown>,
  ): Promise<AdminResponse<CmDocument>>;
  /** "Unpublish" (optionally "and discard the draft"). */
  unpublish(
    uid: string,
    documentId: string,
    options?: { discardDraft?: boolean },
  ): Promise<AdminResponse<CmDocument>>;
  /** "Discard changes". */
  discard(uid: string, documentId: string): Promise<AdminResponse<CmDocument>>;
  /** "Duplicate": the clone, with the form's data merged over the copy. */
  clone(
    uid: string,
    sourceDocumentId: string,
    data?: Record<string, unknown>,
  ): Promise<AdminResponse<CmDocument>>;
  /** "Delete document". */
  delete(uid: string, documentId: string): Promise<AdminResponse<unknown>>;
  /** The edit view's read (`status` draft or published). */
  findOne(
    uid: string,
    documentId: string,
    status?: "draft" | "published",
  ): Promise<AdminResponse<CmDocument>>;
}

/** Signs in the seeded super admin (or `token`) and returns the panel's calls. */
export async function contentManager(t: TestStrapi, token?: string): Promise<ContentManager> {
  const jwt = token ?? (await adminToken(t));
  const call = <T>(path: string, init: { method?: string; json?: unknown } = {}) =>
    adminRequest<T>(t, jwt, path, init);
  return {
    token: jwt,
    create: (uid, data) => call(cmPath(uid), { method: "POST", json: data }),
    createAndPublish: (uid, data) =>
      call(cmPath(uid, undefined, "publish"), { method: "POST", json: data }),
    update: (uid, documentId, data) => call(cmPath(uid, documentId), { method: "PUT", json: data }),
    publish: (uid, documentId, data = {}) =>
      call(cmPath(uid, documentId, "publish"), { method: "POST", json: data }),
    unpublish: (uid, documentId, options = {}) =>
      call(cmPath(uid, documentId, "unpublish"), {
        method: "POST",
        json: { discardDraft: options.discardDraft === true },
      }),
    discard: (uid, documentId) =>
      call(cmPath(uid, documentId, "discard"), { method: "POST", json: {} }),
    clone: (uid, sourceDocumentId, data = {}) =>
      call(`/content-manager/collection-types/${uid}/clone/${sourceDocumentId}`, {
        method: "POST",
        json: data,
      }),
    delete: (uid, documentId) => call(cmPath(uid, documentId), { method: "DELETE" }),
    findOne: (uid, documentId, status = "draft") =>
      call(`${cmPath(uid, documentId)}?status=${status}`),
  };
}

interface UsersPermissionsUserService {
  add(values: Record<string, unknown>): Promise<Row>;
}

/** A user `createUser` added, with the password `signIn` uses. */
export type CreatedUser = TestUser;

/**
 * Adds an intranet user of `role` (any TEST_ROLES entry), optionally in
 * `department` (a department row), through the users-permissions user
 * service, as the harness fixtures are written.
 */
export async function createUser(
  t: TestStrapi,
  role: TestRole,
  department?: Pick<Row, "id"> | null,
): Promise<CreatedUser> {
  const roleRow = await t.strapi.db
    .query("plugin::users-permissions.role")
    .findOne({ where: { type: role } });
  if (!roleRow) throw new Error(`[integration] role ${role} missing`);
  const suffix = randomBytes(4).toString("hex");
  const username = `it-${role.replace(/_/g, "-")}-${suffix}`;
  const password = randomBytes(12).toString("base64url");
  const service = t.strapi
    .plugin("users-permissions")
    .service("user") as UsersPermissionsUserService;
  const user = await service.add({
    username,
    email: `${username}@integration.test`,
    displayName: `Extra ${role} ${suffix}`,
    provider: "local",
    password,
    confirmed: true,
    blocked: false,
    role: roleRow.id,
    department: department ? department.id : null,
  });
  return {
    id: user.id,
    documentId: user.documentId,
    username,
    email: `${username}@integration.test`,
    displayName: `Extra ${role} ${suffix}`,
    password,
  };
}

/** The content-API JWT of a user (POST /api/auth/local). */
export function signIn(
  t: TestStrapi,
  user: Pick<TestUser, "username" | "password">,
): Promise<string> {
  return t.login(user.username, user.password);
}
