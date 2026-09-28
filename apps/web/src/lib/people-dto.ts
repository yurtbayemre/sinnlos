import { avatarThumbUrl } from "@/lib/config";
import type { UserLite } from "@/lib/types";

/**
 * Lean user DTOs for the client components of /kudos, /people and the org
 * chart (WD05). Server pages map the directory rows here BEFORE they cross
 * the client boundary: a client component's props are serialised into the
 * page, so every field sent is shipped to the browser for every user.
 * Each query below asks the CMS for exactly the fields its DTO keeps.
 */

type AvatarLike = UserLite["avatar"];

/** The smallest stored rendition of an avatar (thumbnail, small, original), unresolved. */
export function avatarThumbPath(avatar: AvatarLike): string | null {
  if (!avatar) return null;
  return avatar.formats?.thumbnail?.url ?? avatar.formats?.small?.url ?? avatar.url ?? null;
}

const AVATAR_FIELDS = "populate[avatar][fields][0]=url&populate[avatar][fields][1]=formats";

// ---------------------------------------------------------------------------
// Kudos picker
// ---------------------------------------------------------------------------

/** One colleague the kudos picker offers. */
export interface KudosRecipient {
  id: number;
  displayName: string;
  jobTitle: string | null;
  avatarUrl: string | null;
}

/**
 * The /api/users query of the kudos picker: name, job title and avatar
 * only; blocked accounts and the caller left out by the CMS. `blocked` is a
 * plain users-permissions field every role may filter on; NULL (an account
 * written outside users-permissions) counts as not blocked. No email or
 * phone filter or sort: the picker searches name and job title only.
 */
export function kudosRecipientQuery(selfId: number | null): string {
  const self = selfId === null ? "" : `&filters[id][$ne]=${selfId}`;
  return (
    `fields[0]=displayName&fields[1]=username&fields[2]=jobTitle&${AVATAR_FIELDS}` +
    `&filters[$or][0][blocked][$ne]=true&filters[$or][1][blocked][$null]=true${self}` +
    `&sort=displayName:asc,id:asc`
  );
}

/**
 * The picker's DTOs, in directory order. The CMS already filtered blocked
 * accounts and the caller; both are dropped here again, so a stale or
 * mocked response cannot offer them either.
 */
export function toKudosRecipients(
  users: (UserLite & { blocked?: boolean | null })[],
  selfId: number | null,
): KudosRecipient[] {
  const out: KudosRecipient[] = [];
  for (const user of users) {
    if (typeof user?.id !== "number" || user.id === selfId || user.blocked === true) continue;
    const displayName = user.displayName || user.username;
    if (!displayName) continue;
    out.push({
      id: user.id,
      displayName,
      jobTitle: user.jobTitle || null,
      avatarUrl: avatarThumbUrl(user.avatar),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// People directory
// ---------------------------------------------------------------------------

/** One card of the /people grid. */
export interface PersonCard {
  id: number;
  /** Display name, else username; null renders the "unknown" label. */
  name: string | null;
  jobTitle: string | null;
  /** Only for the search box; the CMS strips it for non-staff callers. */
  email: string | null;
  department: { name: string; slug: string | null } | null;
  avatarUrl: string | null;
}

/**
 * Cards the /people grid renders per step: a large directory used to mount
 * every card at once. 48 fills whole rows at 2, 3 and 4 columns.
 */
export const PEOPLE_PAGE_SIZE = 48;

/** How many cards to show after `pages` steps, never more than the matches. */
export function visibleCount(matches: number, pages: number): number {
  return Math.min(matches, Math.max(1, pages) * PEOPLE_PAGE_SIZE);
}

/** The /api/users query of /people: the card fields only. */
export const PEOPLE_QUERY =
  `fields[0]=username&fields[1]=displayName&fields[2]=jobTitle&fields[3]=email` +
  `&populate[department][fields][0]=name&populate[department][fields][1]=slug&${AVATAR_FIELDS}` +
  `&sort=displayName:asc,id:asc`;

export function toPersonCards(users: UserLite[]): PersonCard[] {
  return users
    .filter((user) => typeof user?.id === "number")
    .map((user) => ({
      id: user.id,
      name: user.displayName || user.username || user.email || null,
      jobTitle: user.jobTitle || null,
      email: user.email || null,
      department: user.department?.name
        ? { name: user.department.name, slug: user.department.slug || null }
        : null,
      avatarUrl: avatarThumbUrl(user.avatar),
    }));
}

// ---------------------------------------------------------------------------
// Org chart
// ---------------------------------------------------------------------------

/** One org chart node as components/people/org-tree.tsx reads it. */
export type OrgPerson = Pick<UserLite, "id" | "displayName" | "username" | "jobTitle"> & {
  department: { id: number; name: string; slug: string } | null;
  /** Only the chosen rendition, unresolved: OrgTree resolves it. */
  avatar: { url: string } | null;
  manager: { id: number } | null;
};

/** The /api/users query of the org chart: the node fields and the manager's id. */
export const ORG_CHART_QUERY =
  `fields[0]=username&fields[1]=displayName&fields[2]=jobTitle` +
  `&populate[manager][fields][0]=id` +
  `&populate[department][fields][0]=name&populate[department][fields][1]=slug&${AVATAR_FIELDS}` +
  `&sort=displayName:asc,id:asc`;

export function toOrgPeople(users: UserLite[]): OrgPerson[] {
  return users
    .filter((user) => typeof user?.id === "number")
    .map((user) => {
      const thumb = avatarThumbPath(user.avatar);
      const department = user.department;
      return {
        id: user.id,
        displayName: user.displayName,
        username: user.username,
        jobTitle: user.jobTitle,
        department:
          department && typeof department.id === "number" && department.name
            ? { id: department.id, name: department.name, slug: department.slug ?? "" }
            : null,
        avatar: thumb ? { url: thumb } : null,
        manager: typeof user.manager?.id === "number" ? { id: user.manager.id } : null,
      };
    });
}
