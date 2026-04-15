/**
 * Extends the users-permissions plugin so that Microsoft logins:
 *   1. Upsert a Strapi user keyed on the Entra ID `oid` claim (stable).
 *   2. Pull displayName / jobTitle / department from Microsoft Graph `/me`.
 *   3. Assign a Strapi role based on Entra group membership (ms-role-map.ts).
 *
 * Strapi v5 plugin extension pattern:
 *   export default (plugin) => { ...mutate plugin...; return plugin; }
 */
import rules, { DEFAULT_ROLE, type StrapiRoleType } from "../../../config/ms-role-map";

type AnyPlugin = {
  controllers: Record<string, any>;
  services: Record<string, any>;
  contentTypes: Record<string, any>;
};

interface GraphMeResponse {
  id: string;
  displayName?: string;
  givenName?: string;
  surname?: string;
  jobTitle?: string;
  mail?: string;
  userPrincipalName?: string;
  department?: string;
  officeLocation?: string;
}

interface GraphGroupsResponse {
  value: Array<{ id: string; displayName?: string }>;
}

async function fetchGraphMe(accessToken: string): Promise<GraphMeResponse | null> {
  try {
    const res = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as GraphMeResponse;
  } catch {
    return null;
  }
}

async function fetchGraphGroups(accessToken: string): Promise<GraphGroupsResponse["value"]> {
  try {
    const res = await fetch(
      "https://graph.microsoft.com/v1.0/me/memberOf?$select=id,displayName",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as GraphGroupsResponse;
    return json.value ?? [];
  } catch {
    return [];
  }
}

function resolveRoleType(groups: GraphGroupsResponse["value"]): StrapiRoleType {
  const needle = new Set<string>();
  for (const g of groups) {
    if (g.id) needle.add(g.id.toLowerCase());
    if (g.displayName) needle.add(g.displayName.toLowerCase());
  }
  for (const rule of rules) {
    if (needle.has(rule.group.toLowerCase())) return rule.role;
  }
  return DEFAULT_ROLE;
}

export default (plugin: AnyPlugin) => {
  const originalCallback = plugin.controllers.auth.callback;

  plugin.controllers.auth.callback = async (ctx: any) => {
    const provider = ctx.params.provider;
    if (provider !== "microsoft") {
      return originalCallback(ctx);
    }

    // Let the original flow validate + issue its JWT first, then enrich
    // the user record with Graph data before responding.
    await originalCallback(ctx);

    const responseBody = ctx.body as { jwt?: string; user?: { id: number; email: string } };
    if (!responseBody?.user) return;

    const accessToken = ctx.query?.access_token as string | undefined;
    if (!accessToken) return;

    const [me, groups] = await Promise.all([
      fetchGraphMe(accessToken),
      fetchGraphGroups(accessToken),
    ]);

    const roleType = resolveRoleType(groups);

    const roleEntity = await strapi.db.query("plugin::users-permissions.role").findOne({
      where: { type: roleType },
    });

    // Look up department by name (if Graph exposed one)
    let departmentId: number | undefined;
    if (me?.department) {
      const dept = await strapi.db.query("api::department.department").findOne({
        where: { name: me.department },
      });
      if (dept) departmentId = dept.id;
    }

    const update: Record<string, unknown> = {
      microsoftOid: me?.id,
      displayName: me?.displayName ?? responseBody.user.email,
      jobTitle: me?.jobTitle,
    };
    if (roleEntity) update.role = roleEntity.id;
    if (departmentId) update.department = departmentId;

    await strapi.db.query("plugin::users-permissions.user").update({
      where: { id: responseBody.user.id },
      data: update,
    });

    // Refresh the response user with the patched values
    const refreshed = await strapi.db.query("plugin::users-permissions.user").findOne({
      where: { id: responseBody.user.id },
      populate: ["role", "department"],
    });
    ctx.body = { ...responseBody, user: refreshed };
  };

  return plugin;
};
