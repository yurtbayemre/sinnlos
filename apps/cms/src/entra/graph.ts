/**
 * Microsoft Graph calls of the Entra exchange (D-ENTRA-01 spec G), made
 * with the user's delegated access token that Auth.js obtained (scope
 * 'openid profile email User.Read', plus User.Read.All with
 * ENTRA_SYNC_MANAGER=1).
 *
 * Every call: 3 s timeout (AbortSignal.timeout), no retry (a 429 is a
 * failure like any other status), and a typed result instead of a throw:
 * `{ ok: true, data }` or `{ ok: false, reason }` with the HTTP status,
 * 'timeout', 'network' or 'malformed'. The token only ever travels in the
 * Authorization header; results, errors and logs never contain it.
 *
 * The exchange runs the calls in parallel. A failure never fails the sign-in
 * of an existing user and never changes a role, department or manager
 * (spec K); how each result is used lives in roles.ts, profile.ts and
 * provision.ts.
 */
import { GUID_PATTERN } from "./config";

export const GRAPH_TIMEOUT_MS = 3000;

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** The /me fields the exchange reads. */
export const GRAPH_ME_URL = `${GRAPH_BASE}/me?$select=id,displayName,mail,userPrincipalName,jobTitle,department,officeLocation,businessPhones,userType`;
export const GRAPH_CHECK_MEMBER_GROUPS_URL = `${GRAPH_BASE}/me/checkMemberGroups`;
export const GRAPH_MANAGER_URL = `${GRAPH_BASE}/me/manager?$select=id`;

export type GraphFailure = number | "timeout" | "network" | "malformed";

export type GraphResult<T> = { ok: true; data: T } | { ok: false; reason: GraphFailure };

/** The signed-in user as /me returns it (unset or non-string values are null). */
export interface GraphMe {
  /** Lower-cased object id; the exchange requires it to equal the token's oid. */
  id: string;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string | null;
  jobTitle: string | null;
  department: string | null;
  officeLocation: string | null;
  businessPhones: string[];
  /** 'Member' for tenant members, 'Guest' for B2B guests. */
  userType: string | null;
}

export interface GraphOptions {
  /** Test seam; the global fetch otherwise. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * One Graph request: the parsed JSON body of a 200, or the failure. A
 * timeout while the body is read is a timeout too.
 */
async function graphJson(
  url: string,
  accessToken: string,
  init: { method: "GET" | "POST"; body?: unknown },
  options: GraphOptions,
): Promise<GraphResult<unknown>> {
  const fetchImpl = options.fetch ?? fetch;
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  try {
    const response = await fetchImpl(url, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? GRAPH_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      // Release the body (its content is unused); never wait for it.
      void response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: response.status };
    }
    try {
      return { ok: true, data: (await response.json()) as unknown };
    } catch (err) {
      return { ok: false, reason: isTimeout(err) ? "timeout" : "malformed" };
    }
  } catch (err) {
    return { ok: false, reason: isTimeout(err) ? "timeout" : "network" };
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** GET /me with the exchange's $select. */
export async function fetchGraphMe(
  accessToken: string,
  options: GraphOptions = {},
): Promise<GraphResult<GraphMe>> {
  const result = await graphJson(GRAPH_ME_URL, accessToken, { method: "GET" }, options);
  if (result.ok === false) return result;
  const body = result.data;
  if (!isObject(body) || typeof body.id !== "string" || !GUID_PATTERN.test(body.id)) {
    return { ok: false, reason: "malformed" };
  }
  return {
    ok: true,
    data: {
      id: body.id.toLowerCase(),
      displayName: stringOrNull(body.displayName),
      mail: stringOrNull(body.mail),
      userPrincipalName: stringOrNull(body.userPrincipalName),
      jobTitle: stringOrNull(body.jobTitle),
      department: stringOrNull(body.department),
      officeLocation: stringOrNull(body.officeLocation),
      businessPhones: Array.isArray(body.businessPhones)
        ? body.businessPhones.filter((phone): phone is string => typeof phone === "string")
        : [],
      userType: stringOrNull(body.userType),
    },
  };
}

/**
 * POST /me/checkMemberGroups: which of `groupIds` (at most 20, lower-case)
 * the user is a transitive member of. The answer must be an array of
 * strings, every one of them from the input; anything else is 'malformed'.
 * Microsoft documents that hidden-membership groups may be left out.
 */
export async function checkMemberGroups(
  accessToken: string,
  groupIds: readonly string[],
  options: GraphOptions = {},
): Promise<GraphResult<string[]>> {
  const result = await graphJson(
    GRAPH_CHECK_MEMBER_GROUPS_URL,
    accessToken,
    { method: "POST", body: { groupIds } },
    options,
  );
  if (result.ok === false) return result;
  const value = isObject(result.data) ? result.data.value : undefined;
  if (!Array.isArray(value)) return { ok: false, reason: "malformed" };
  const asked = new Set(groupIds.map((id) => id.toLowerCase()));
  const members: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !asked.has(id.toLowerCase())) {
      return { ok: false, reason: "malformed" };
    }
    if (!members.includes(id.toLowerCase())) members.push(id.toLowerCase());
  }
  return { ok: true, data: members };
}

/**
 * GET /me/manager: the manager's lower-cased object id, or null when the
 * user has none (404). Every other answer is unknown.
 */
export async function fetchManagerOid(
  accessToken: string,
  options: GraphOptions = {},
): Promise<GraphResult<string | null>> {
  const result = await graphJson(GRAPH_MANAGER_URL, accessToken, { method: "GET" }, options);
  if (result.ok === false) return result.reason === 404 ? { ok: true, data: null } : result;
  const body = result.data;
  if (!isObject(body) || typeof body.id !== "string" || !GUID_PATTERN.test(body.id)) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, data: body.id.toLowerCase() };
}

/** For the audit line: ok, the status, timeout, network, malformed; or off when not asked. */
export function describeGraphResult(result: GraphResult<unknown> | null): string {
  if (result === null) return "off";
  if (result.ok === false) return String(result.reason);
  return "ok";
}
