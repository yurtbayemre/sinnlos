import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestStrapi, testEngines, type Row, type TestStrapi } from "./harness.test.helper";

/**
 * Blocked people leave the directory (v0.28, plan rev2 §1 + rev3 R1), over
 * real HTTP against the running cms:
 *   - /api/users and /api/users/:id (404) list active users only, for every
 *     role, admin_role included;
 *   - the directory relations (department head/members, team lead/members,
 *     manager/direct reports) populate active users only, at depth 2 and in
 *     the count form;
 *   - a populated author keeps its attribution only (id, documentId,
 *     displayName, username, blocked), for staff too, and an explicit field
 *     list cannot bring the contact data back;
 *   - kudos to a blocked person are refused (400 `recipient`), and /api/me
 *     no longer names a blocked manager.
 */

const USER = "plugin::users-permissions.user";

interface UserRow {
  id: number;
  documentId?: string;
  username?: string;
  displayName?: string;
  email?: string;
  phone?: string;
  jobTitle?: string;
  blocked?: boolean;
  manager?: unknown;
}

describe.each(testEngines())("blocked people hidden on %s", (engine) => {
  let t: TestStrapi;
  let gone: Row;
  let announcement: Row;

  beforeAll(async () => {
    t = await createTestStrapi({ engine });
    const { engineering, platform } = { ...t.fixtures.departments, ...t.fixtures.teams };
    const roles = t.strapi.db.query("plugin::users-permissions.role");
    const member = await roles.findOne({ where: { type: "member" } });
    const userService = t.strapi.plugin("users-permissions").service("user") as {
      add(values: Record<string, unknown>): Promise<Row>;
    };
    gone = (await userService.add({
      username: "it-gone",
      email: "it-gone@integration.test",
      displayName: "Gone Person",
      jobTitle: "Former lead",
      phone: "+49 30 9999",
      provider: "local",
      password: "Gone-Password-2026!",
      confirmed: true,
      blocked: true,
      role: member?.id,
      department: engineering.id,
    })) as Row;
    // Team lead and member of the platform team, and the member's manager.
    await t.strapi.documents("api::team.team").update({
      documentId: platform.documentId as string,
      data: { lead: gone.documentId, members: { connect: [gone.documentId] } },
    });
    await t.strapi.db
      .query(USER)
      .update({ where: { id: t.fixtures.users.member.id }, data: { manager: gone.id } });
    announcement = await t.strapi.documents("api::announcement.announcement").create({
      data: { title: "IT blocked author", audience: "all", author: gone.documentId },
      status: "published",
    });
  });

  afterAll(async () => {
    await t?.stop();
  });

  const ids = (rows: UserRow[] | undefined) => (rows ?? []).map((row) => row.id);

  it("/api/users and /api/users/:id list active users only", async () => {
    for (const caller of ["admin_role", "member"] as const) {
      const list = await t.api<UserRow[]>(caller, "/api/users?limit=100");
      expect(list.status, caller).toBe(200);
      expect(ids(list.body), caller).not.toContain(gone.id);
      expect(ids(list.body), caller).toContain(t.fixtures.users.member.id);
      expect((await t.api(caller, `/api/users/${gone.id}`)).status, caller).toBe(404);
      expect((await t.api(caller, `/api/users/${t.fixtures.users.member.id}`)).status).toBe(200);
      // No role holds user.count (the web counts its own pages); the root
      // filter of the sanitize wrapper would apply to it as well.
      expect((await t.api(caller, "/api/users/count")).status, caller).toBe(403);
    }
    // The client cannot ask for them either.
    const asked = await t.api<UserRow[]>("member", "/api/users?filters[blocked][$eq]=true");
    expect(asked.body).toEqual([]);
  });

  it("department and team directories leave them out, also nested and counted", async () => {
    const departments = await t.api<{ data: { members?: UserRow[] }[] }>(
      "member",
      "/api/departments?populate[members]=true&filters[slug][$eq]=it-engineering",
    );
    expect(departments.status).toBe(200);
    expect(ids(departments.body.data[0].members)).not.toContain(gone.id);
    expect(ids(departments.body.data[0].members)).toContain(t.fixtures.users.member.id);

    const teams = await t.api<{ data: { lead?: UserRow | null; members?: { count: number } }[] }>(
      "editor",
      "/api/teams?populate[lead]=true&populate[members][count]=true&filters[slug][$eq]=it-platform",
    );
    expect(teams.status).toBe(200);
    expect(teams.body.data[0].lead).toBeNull();
    // team_lead and member; the blocked lead-and-member is not counted.
    expect(teams.body.data[0].members).toEqual({ count: 2 });

    const nested = await t.api<UserRow[] & { department?: { members?: UserRow[] } }[]>(
      "member",
      `/api/users?filters[id][$eq]=${t.fixtures.users.member.id}&populate[department][populate][members]=true&populate[manager]=true`,
    );
    expect(nested.status).toBe(200);
    const self = nested.body[0] as unknown as {
      department: { members: UserRow[] };
      manager: unknown;
    };
    expect(ids(self.department.members)).not.toContain(gone.id);
    expect(self.manager).toBeNull();
  });

  it("a populated author keeps the attribution only, for staff too, also with explicit fields", async () => {
    const attribution = {
      id: gone.id,
      documentId: gone.documentId,
      username: "it-gone",
      displayName: "Gone Person",
      blocked: true,
    };
    for (const caller of ["editor", "member"] as const) {
      const all = await t.api<{ data: { author?: UserRow }[] }>(
        caller,
        `/api/announcements?filters[documentId][$eq]=${announcement.documentId}&populate[author][populate][manager]=true`,
      );
      expect(all.status, caller).toBe(200);
      expect(all.body.data[0].author, caller).toEqual(attribution);

      const fields = await t.api<{ data: { author?: UserRow }[] }>(
        caller,
        `/api/announcements?filters[documentId][$eq]=${announcement.documentId}&populate[author][fields][0]=email&populate[author][fields][1]=jobTitle`,
      );
      expect(fields.status, caller).toBe(200);
      expect(fields.body.data[0].author, caller).not.toHaveProperty("email");
      expect(fields.body.data[0].author, caller).not.toHaveProperty("jobTitle");
      expect(fields.body.data[0].author?.blocked, caller).toBe(true);
    }
  });

  it("withheld fields cannot be probed through filters or sort (Codex review)", async () => {
    const byAnnouncement = `filters[documentId][$eq]=${announcement.documentId}`;
    for (const caller of ["editor", "member"] as const) {
      const email = await t.api<{ data: Row[] }>(
        caller,
        `/api/announcements?${byAnnouncement}&filters[author][email][$eq]=it-gone@integration.test`,
      );
      expect(email.status, caller).toBe(200);
      expect(email.body.data, caller).toEqual([]);
      // The attribution stays findable: the author's content is the record.
      const id = await t.api<{ data: Row[] }>(
        caller,
        `/api/announcements?${byAnnouncement}&filters[author][id][$eq]=${gone.id}`,
      );
      expect(
        id.body.data.map((row) => row.documentId),
        caller,
      ).toEqual([announcement.documentId]);
      const populated = await t.api<{ data: { author?: unknown }[] }>(
        caller,
        `/api/announcements?${byAnnouncement}&populate[author][filters][phone][$eq]=%2B49%2030%209999`,
      );
      expect(populated.body.data[0].author ?? null, caller).toBeNull();
      expect((await t.api(caller, `/api/announcements?sort=author.email:asc`)).status, caller).toBe(
        400,
      );
    }
  });

  it("refuses kudos to a blocked person, and /api/me names no blocked manager", async () => {
    const kudos = await t.api<{ error?: { details?: { code?: string } } }>(
      "member",
      "/api/kudos-entries",
      { json: { data: { to: gone.id, message: "Thanks", value: "teamwork" } } },
    );
    expect(kudos.status).toBe(400);
    expect(kudos.body.error?.details?.code).toBe("recipient");

    const me = await t.api<{ data: { manager: unknown } }>("member", "/api/me");
    expect(me.status).toBe(200);
    expect(me.body.data.manager).toBeNull();
  });
});
