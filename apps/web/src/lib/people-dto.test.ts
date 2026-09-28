import { describe, expect, it, vi } from "vitest";

/**
 * Lean user DTOs for /kudos, /people and the org chart (WD05): what crosses
 * the client boundary, and the /api/users queries behind it. `@/lib/config`
 * is mocked with the local upload provider's relative paths.
 */
vi.mock("@/lib/config", () => ({
  avatarThumbUrl: (avatar: { url?: string; formats?: { thumbnail?: { url?: string } } } | null) =>
    avatar ? (avatar.formats?.thumbnail?.url ?? avatar.url ?? null) : null,
}));

const {
  ORG_CHART_QUERY,
  PEOPLE_PAGE_SIZE,
  PEOPLE_QUERY,
  avatarThumbPath,
  kudosRecipientQuery,
  toKudosRecipients,
  toOrgPeople,
  toPersonCards,
  visibleCount,
} = await import("./people-dto");

const avatar = {
  url: "/uploads/full.jpg",
  formats: {
    thumbnail: { url: "/uploads/thumb_full.jpg" },
    small: { url: "/uploads/small_full.jpg" },
  },
};

/** Everything a full /api/users row may carry, sensitive fields included. */
const fullRow = {
  id: 7,
  username: "ada",
  email: "ada@example.test",
  displayName: "Ada Lovelace",
  jobTitle: "Engineer",
  phone: "+49 1",
  officeLocation: "Room 1",
  hireDate: "2020-01-01",
  avatar,
  department: { id: 10, name: "Engineering", slug: "engineering" },
  manager: { id: 3, username: "boss", email: "boss@example.test" },
  directReports: [{ id: 9 }],
};

/** The query-string keys of a users query, for the "no sensitive field" checks. */
const keys = (query: string) => [...new URLSearchParams(query).keys()];
const SENSITIVE = ["email", "phone", "hireDate", "officeLocation", "microsoftOid"];

describe("kudos picker", () => {
  it("asks for name, job title and avatar only, active colleagues but the caller", () => {
    const query = kudosRecipientQuery(7);
    expect(query).toBe(
      "fields[0]=displayName&fields[1]=username&fields[2]=jobTitle" +
        "&populate[avatar][fields][0]=url&populate[avatar][fields][1]=formats" +
        "&filters[$or][0][blocked][$ne]=true&filters[$or][1][blocked][$null]=true" +
        "&filters[id][$ne]=7&sort=displayName:asc,id:asc",
    );
    expect(kudosRecipientQuery(null)).not.toContain("filters[id]");
  });

  it("never filters, sorts or selects a sensitive field (the guest guard would 400)", () => {
    for (const key of keys(kudosRecipientQuery(7))) {
      for (const field of SENSITIVE) expect(key, key).not.toContain(field);
    }
    expect(kudosRecipientQuery(7)).not.toMatch(/email|phone|hireDate|officeLocation/);
  });

  it("maps to the minimal DTO and drops the caller, blocked and nameless rows", () => {
    const recipients = toKudosRecipients(
      [
        fullRow,
        { ...fullRow, id: 8, displayName: undefined, username: "grace", jobTitle: "" },
        { ...fullRow, id: 5 }, // the caller
        { ...fullRow, id: 11, blocked: true },
        { id: 12 },
        { ...fullRow, id: 13, avatar: null },
      ],
      5,
    );
    expect(recipients).toEqual([
      {
        id: 7,
        displayName: "Ada Lovelace",
        jobTitle: "Engineer",
        avatarUrl: "/uploads/thumb_full.jpg",
      },
      { id: 8, displayName: "grace", jobTitle: null, avatarUrl: "/uploads/thumb_full.jpg" },
      { id: 13, displayName: "Ada Lovelace", jobTitle: "Engineer", avatarUrl: null },
    ]);
    expect(JSON.stringify(recipients)).not.toMatch(/@example|Room|2020|\+49/);
  });
});

describe("people grid", () => {
  it("asks for the card fields only, with a stable sort", () => {
    expect(PEOPLE_QUERY).toBe(
      "fields[0]=username&fields[1]=displayName&fields[2]=jobTitle&fields[3]=email" +
        "&populate[department][fields][0]=name&populate[department][fields][1]=slug" +
        "&populate[avatar][fields][0]=url&populate[avatar][fields][1]=formats" +
        "&sort=displayName:asc,id:asc",
    );
    // email is selected for the search box, but never filtered or sorted on.
    expect(keys(PEOPLE_QUERY).filter((key) => /filters|sort/.test(key))).toEqual(["sort"]);
    expect(new URLSearchParams(PEOPLE_QUERY).get("sort")).not.toMatch(/email|phone/);
  });

  it("maps to the lean card", () => {
    expect(toPersonCards([fullRow])).toEqual([
      {
        id: 7,
        name: "Ada Lovelace",
        jobTitle: "Engineer",
        email: "ada@example.test",
        department: { name: "Engineering", slug: "engineering" },
        avatarUrl: "/uploads/thumb_full.jpg",
      },
    ]);
  });

  it("falls back from display name to username to email, and reads gaps as null", () => {
    const cards = toPersonCards([
      { id: 1, username: "u1" },
      { id: 2, email: "x@example.test" },
      { id: 3 },
      { id: 4, department: { id: 1, name: "", slug: "" } },
    ]);
    expect(cards.map((c) => c.name)).toEqual(["u1", "x@example.test", null, null]);
    expect(cards[3]).toMatchObject({
      department: null,
      jobTitle: null,
      email: null,
      avatarUrl: null,
    });
  });

  it("pages in steps of 48, never past the matches", () => {
    expect(PEOPLE_PAGE_SIZE).toBe(48);
    expect(visibleCount(10, 1)).toBe(10);
    expect(visibleCount(100, 1)).toBe(48);
    expect(visibleCount(100, 2)).toBe(96);
    expect(visibleCount(100, 3)).toBe(100);
    expect(visibleCount(100, 0)).toBe(48);
    expect(visibleCount(0, 1)).toBe(0);
  });
});

describe("org chart", () => {
  it("asks for the node fields and only the manager's id", () => {
    expect(ORG_CHART_QUERY).toBe(
      "fields[0]=username&fields[1]=displayName&fields[2]=jobTitle" +
        "&populate[manager][fields][0]=id" +
        "&populate[department][fields][0]=name&populate[department][fields][1]=slug" +
        "&populate[avatar][fields][0]=url&populate[avatar][fields][1]=formats" +
        "&sort=displayName:asc,id:asc",
    );
    expect(ORG_CHART_QUERY).not.toMatch(/email|phone|hireDate|officeLocation/);
  });

  it("maps to the lean node with the chosen avatar rendition and the manager id", () => {
    expect(toOrgPeople([fullRow])).toEqual([
      {
        id: 7,
        displayName: "Ada Lovelace",
        username: "ada",
        jobTitle: "Engineer",
        department: { id: 10, name: "Engineering", slug: "engineering" },
        avatar: { url: "/uploads/thumb_full.jpg" },
        manager: { id: 3 },
      },
    ]);
    expect(JSON.stringify(toOrgPeople([fullRow]))).not.toMatch(/@example|Room|2020|\+49|boss/);
  });

  it("reads a missing manager, department or avatar as null", () => {
    expect(toOrgPeople([{ id: 1, username: "u1" }])).toEqual([
      {
        id: 1,
        displayName: undefined,
        username: "u1",
        jobTitle: undefined,
        department: null,
        avatar: null,
        manager: null,
      },
    ]);
  });
});

describe("avatarThumbPath", () => {
  it("prefers the thumbnail, then small, then the original", () => {
    expect(avatarThumbPath(avatar)).toBe("/uploads/thumb_full.jpg");
    expect(
      avatarThumbPath({ url: "/uploads/a.jpg", formats: { small: { url: "/uploads/s.jpg" } } }),
    ).toBe("/uploads/s.jpg");
    expect(avatarThumbPath({ url: "/uploads/a.jpg", formats: null })).toBe("/uploads/a.jpg");
    expect(avatarThumbPath(null)).toBeNull();
    expect(avatarThumbPath({})).toBeNull();
  });
});
