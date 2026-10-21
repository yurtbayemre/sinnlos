import {
  ROLE_PRIVILEGE_ORDER,
  type RoleType,
  type UserAdminDetail,
  type UserAdminUpdate,
} from "@sinnlos/domain";

/** The user form's values (v0.23). */
export interface UserValues {
  /** "" only for a user without an intranet role; the picker offers roles only. */
  role: RoleType | "";
  /** A department's documentId, or "" for none. */
  department: string;
  /** The manager's user id, or null. */
  manager: number | null;
  blocked: boolean;
}

export function userValuesFromDetail(user: UserAdminDetail): UserValues {
  return {
    role: user.role ?? "",
    department: user.department?.documentId ?? "",
    manager: user.manager?.id ?? null,
    blocked: user.blocked,
  };
}

const isRole = (value: unknown): value is RoleType =>
  (ROLE_PRIVILEGE_ORDER as readonly unknown[]).includes(value);
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

/** The values a server action received, or null for any other shape. */
export function coerceUserValues(raw: unknown): UserValues | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    (r.role !== "" && !isRole(r.role)) ||
    typeof r.department !== "string" ||
    (r.manager !== null && !isId(r.manager)) ||
    typeof r.blocked !== "boolean"
  )
    return null;
  return {
    role: r.role as RoleType | "",
    department: r.department,
    manager: r.manager as number | null,
    blocked: r.blocked,
  };
}

/** Only the changed fields: two admins editing other fields of one user do not undo each other. */
export function buildUserPayload(values: UserValues, initial: UserValues): UserAdminUpdate {
  const data: UserAdminUpdate = {};
  if (values.role !== initial.role && values.role !== "") data.role = values.role;
  if (values.department !== initial.department) data.department = values.department || null;
  if (values.manager !== initial.manager) data.manager = values.manager;
  if (values.blocked !== initial.blocked) data.blocked = values.blocked;
  return data;
}
