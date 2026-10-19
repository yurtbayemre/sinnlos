import type { Department, UserLite } from "@/lib/types";

/** The demo user (DEMO_SESSION, DEMO_VIEWER): Ada Lovelace. */
export const DEMO_USER_ID = 1;

export function demoUsers() {
  return {
    ada: {
      id: DEMO_USER_ID,
      username: "ada",
      email: "ada@sinnlos.local",
      displayName: "Ada Lovelace",
      jobTitle: "Head of Engineering",
    },
    grace: {
      id: 2,
      username: "grace",
      email: "grace@sinnlos.local",
      displayName: "Grace Hopper",
      jobTitle: "Platform Lead",
    },
    linus: {
      id: 3,
      username: "linus",
      email: "linus@sinnlos.local",
      displayName: "Linus T.",
      jobTitle: "Senior Engineer",
    },
    maria: {
      id: 4,
      username: "maria",
      email: "maria@sinnlos.local",
      displayName: "Maria Weber",
      jobTitle: "Head of People",
    },
    jonas: {
      id: 5,
      username: "jonas",
      email: "jonas@sinnlos.local",
      displayName: "Jonas Keller",
      jobTitle: "Recruiter",
    },
    sofia: {
      id: 6,
      username: "sofia",
      email: "sofia@sinnlos.local",
      displayName: "Sofia Martín",
      jobTitle: "Head of Marketing",
    },
  } satisfies Record<string, UserLite>;
}

export type DemoUsers = ReturnType<typeof demoUsers>;

/** A department as a relation of another row (no nested relations). */
export const departmentRef = (d: Department) => ({ id: d.id, name: d.name, slug: d.slug });

/** The directory as /api/users answers it: every user with their department. */
export function demoDirectory(users: DemoUsers, departments: Department[]): UserLite[] {
  return Object.values(users).map((u) => {
    const home = departments.find((d) => d.members?.some((m) => m.id === u.id));
    return { ...u, department: home ? departmentRef(home) : null };
  });
}

/** GET /api/me: the demo user's allowlisted self-profile (FX02 shape). */
export function demoMe(users: DemoUsers) {
  return {
    ...users.ada,
    department: {
      id: 1,
      documentId: "demodepartment0000000001",
      name: "Engineering",
      slug: "engineering",
    },
    role: { type: "member", name: "Member" },
    birthdayVisible: false,
  };
}
