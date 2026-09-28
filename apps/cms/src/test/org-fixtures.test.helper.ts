/**
 * A small organisation for the notification, live-event and digest tests,
 * seeded into the shared Strapi stub (S03, strapi-stub.test.helper.ts).
 * Named *.test.helper.ts so the Strapi build skips it and Vitest does not
 * collect it as a suite.
 *
 *   roles        1 admin_role, 2 editor, 3 department_head, 4 team_lead,
 *                5 member, 6 guest, 7 authenticated
 *   departments  10 Engineering, 11 Sales
 *   teams        30 Frontend (lead: dave 104), 31 Backend (no lead)
 *   users        101 alice  member      Engineering, team 30
 *                102 bob    member      Sales
 *                103 carol  editor      Engineering (the usual author)
 *                104 dave   team_lead   Sales, leads team 30 (not a member)
 *                105 gina   guest       Engineering
 *                106 bert   member      Engineering, BLOCKED
 *                107 anna   admin_role  Sales
 *
 * `grants` seeds plugin::users-permissions.permission rows the way the
 * bootstrap matrix does today (apps/cms/src/index.ts PERMISSION_MATRIX):
 * announcement.find and kudos.find for every role but guest, event.find
 * for every role.
 */
import {
  createStrapiStub,
  type ContentTypeSchema,
  type Row,
  type StrapiStub,
  type StrapiStubOptions,
  type Tables,
} from "./strapi-stub.test.helper";

export const USER_UID = "plugin::users-permissions.user";
export const ROLE_UID = "plugin::users-permissions.role";
export const PERMISSION_UID = "plugin::users-permissions.permission";
export const TEAM_UID = "api::team.team";
export const DEPARTMENT_UID = "api::department.department";
export const ANNOUNCEMENT_UID = "api::announcement.announcement";
export const EVENT_UID = "api::event.event";
export const NOTIFICATION_UID = "api::notification.notification";
export const COMMENT_UID = "api::comment.comment";
export const KUDOS_UID = "api::kudos.kudos";

export const ROLE = {
  admin: 1,
  editor: 2,
  departmentHead: 3,
  teamLead: 4,
  member: 5,
  guest: 6,
  authenticated: 7,
} as const;

export const DEPT = { engineering: 10, sales: 11 } as const;
export const TEAM = { frontend: 30, backend: 31 } as const;

export const USER = {
  alice: 101,
  bob: 102,
  carol: 103,
  dave: 104,
  gina: 105,
  bert: 106,
  anna: 107,
} as const;

const ROLES: Row[] = [
  { id: ROLE.admin, type: "admin_role", name: "Admin" },
  { id: ROLE.editor, type: "editor", name: "Editor" },
  { id: ROLE.departmentHead, type: "department_head", name: "Department Head" },
  { id: ROLE.teamLead, type: "team_lead", name: "Team Lead" },
  { id: ROLE.member, type: "member", name: "Member" },
  { id: ROLE.guest, type: "guest", name: "Guest" },
  { id: ROLE.authenticated, type: "authenticated", name: "Authenticated" },
];

function user(
  id: number,
  username: string,
  role: number,
  department: number,
  extra: Record<string, unknown> = {},
): Row {
  return {
    id,
    username,
    email: `${username}@sinnlos.local`,
    displayName: username[0].toUpperCase() + username.slice(1),
    blocked: false,
    confirmed: true,
    locale: "en",
    role: { id: role },
    department: { id: department },
    teams: [],
    digestAnnouncements: false,
    digestMentions: false,
    digestKudos: false,
    digestFrequency: "weekly",
    lastDigestAt: null,
    ...extra,
  };
}

export function orgUsers(): Row[] {
  return [
    user(USER.alice, "alice", ROLE.member, DEPT.engineering, { teams: [{ id: TEAM.frontend }] }),
    user(USER.bob, "bob", ROLE.member, DEPT.sales),
    user(USER.carol, "carol", ROLE.editor, DEPT.engineering),
    user(USER.dave, "dave", ROLE.teamLead, DEPT.sales),
    user(USER.gina, "gina", ROLE.guest, DEPT.engineering),
    user(USER.bert, "bert", ROLE.member, DEPT.engineering, { blocked: true }),
    user(USER.anna, "anna", ROLE.admin, DEPT.sales),
  ];
}

/** Every user id of the fixture, in id order. */
export const ALL_USERS = Object.values(USER).sort((a, b) => a - b);

const READ_ALL_BUT_GUEST = [
  ROLE.admin,
  ROLE.editor,
  ROLE.departmentHead,
  ROLE.teamLead,
  ROLE.member,
  ROLE.authenticated,
];

/** The read grants the fan-outs and the digest resolve at runtime. */
export function orgGrants(): Row[] {
  const rows: Row[] = [];
  let id = 900;
  const grant = (action: string, roles: readonly number[]) => {
    for (const role of roles) rows.push({ id: (id += 1), action, role: { id: role } });
  };
  grant("api::announcement.announcement.find", READ_ALL_BUT_GUEST);
  grant("api::kudos.kudos.find", READ_ALL_BUT_GUEST);
  grant("api::event.event.find", [...READ_ALL_BUT_GUEST, ROLE.guest]);
  // Noise: other actions must not count as read grants.
  grant("api::announcement.announcement.findOne", [ROLE.guest]);
  grant("api::comment.comment.find", [ROLE.guest]);
  return rows;
}

/** users-permissions' permission and role models, which the stub does not load. */
export const PERMISSION_SCHEMAS: Record<string, ContentTypeSchema> = {
  [PERMISSION_UID]: {
    uid: PERMISSION_UID,
    attributes: {
      action: { type: "string" },
      role: { type: "relation", relation: "manyToOne", target: ROLE_UID },
    },
  },
  [ROLE_UID]: {
    uid: ROLE_UID,
    attributes: {
      name: { type: "string" },
      type: { type: "string" },
      description: { type: "string" },
    },
  },
};

export interface OrgStubOptions extends StrapiStubOptions {
  /** Seed the permission rows (default true). */
  grants?: boolean;
  /** Replace or extend the fixture tables. */
  extraTables?: Tables;
}

/** The stub with the organisation above (plus `extraTables`). */
export function createOrgStub(options: OrgStubOptions = {}): StrapiStub {
  const { grants = true, extraTables, tables, schemas, ...rest } = options;
  return createStrapiStub({
    ...rest,
    schemas: { ...PERMISSION_SCHEMAS, ...schemas },
    tables: {
      [ROLE_UID]: ROLES,
      [DEPARTMENT_UID]: [
        { id: DEPT.engineering, name: "Engineering", slug: "engineering" },
        { id: DEPT.sales, name: "Sales", slug: "sales" },
      ],
      [TEAM_UID]: [
        { id: TEAM.frontend, name: "Frontend", lead: { id: USER.dave } },
        { id: TEAM.backend, name: "Backend", lead: null },
      ],
      [USER_UID]: orgUsers(),
      ...(grants ? { [PERMISSION_UID]: orgGrants() } : {}),
      ...tables,
      ...extraTables,
    },
  });
}

/** The recipient ids of the notification rows, sorted. */
export function recipientsOf(
  strapi: StrapiStub,
  where: (row: Row) => boolean = () => true,
): number[] {
  return (strapi.tables[NOTIFICATION_UID] ?? [])
    .filter(where)
    .map((row) => (row.recipient as { id: number } | null)?.id ?? -1)
    .sort((a, b) => a - b);
}

/** The calls the code under test made, as "method uid" strings. */
export function callLog(strapi: StrapiStub): string[] {
  return strapi.calls.map((call) => `${call.method} ${call.uid}`);
}
