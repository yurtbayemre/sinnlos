import { createStrapiStub } from "../test/strapi-stub.test.helper";
import type { AuthoringContext } from "./authoring-controller";
import { CONTENT_VERSION_UID } from "./document-lock";
import type { WriteGateContext, WriteGateHost } from "./write-gate";

export const DEPT = "api::department.department";
export const TEAM = "api::team.team";
export const USER = "plugin::users-permissions.user";
export const ENG = { id: 10, documentId: "deng00000000000000000000" };
export const SALES = { id: 11, documentId: "dsal00000000000000000000" };
export const PLATFORM = { id: 20, documentId: "team00000000000000000000" };
export const HEAD = { id: 3, role: { type: "department_head" } };
export const LEAD = { id: 4, role: { type: "team_lead" } };
export const ADMIN = { id: 1, role: { type: "admin_role" } };
export function world() {
  const strapi = createStrapiStub({
    tables: {
      [DEPT]: [
        {
          ...ENG,
          name: "Engineering",
          slug: "engineering",
          description: "<legacy>raw</legacy>",
          color: "#123456",
          publishedAt: "2026-01-01",
          head: { id: 2 },
        },
        { ...SALES, name: "Sales", publishedAt: null },
      ],
      [TEAM]: [
        {
          ...PLATFORM,
          name: "Platform",
          slug: "platform",
          description: "Team",
          department: { id: ENG.id },
          lead: { id: LEAD.id },
          publishedAt: "2026-01-01",
        },
      ],
      [USER]: [{ id: HEAD.id, department: { id: ENG.id } }, { id: LEAD.id }],
      [CONTENT_VERSION_UID]: [
        { id: 1, targetUid: DEPT, targetDocumentId: ENG.documentId, revision: 7 },
        { id: 2, targetUid: TEAM, targetDocumentId: PLATFORM.documentId, revision: 7 },
      ],
    },
  });
  return { strapi, host: strapi as unknown as WriteGateHost };
}
export function context(
  user: { id: number; role?: { type: string } } | null,
  id: unknown,
  data: unknown = { description: "Updated" },
  query: Record<string, unknown> = {},
) {
  const headers: Record<string, string> = {};
  const ctx: AuthoringContext & WriteGateContext = {
    state: { user },
    params: { id },
    query,
    request: { body: { data }, query },
    get: () => '"7"',
    set: (key, value) => {
      headers[key] = value;
    },
    status: 0,
    body: null,
  };
  return { ctx, headers };
}
