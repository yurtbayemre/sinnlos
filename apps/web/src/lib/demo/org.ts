import type { Department, Team } from "@/lib/types";
import { departmentRef, type DemoUsers } from "./people";

export function demoOrg(users: DemoUsers) {
  const departments = [
    {
      id: 1,
      documentId: "demodepartment0000000001",
      name: "Engineering",
      slug: "engineering",
      description: "We build and operate the product platform.",
      color: "#6366f1",
      head: users.ada,
      members: [users.ada, users.grace, users.linus],
      teams: [
        { id: 10, name: "Platform", slug: "platform", description: "Core infra and APIs" },
        { id: 11, name: "Web", slug: "web", description: "Next.js frontend & design system" },
        { id: 12, name: "Data", slug: "data", description: "Analytics, ML, warehouse" },
      ],
    },
    {
      id: 2,
      documentId: "demodepartment0000000002",
      name: "People & Culture",
      slug: "people-culture",
      description: "Hiring, onboarding, office and wellbeing.",
      color: "#14b8a6",
      head: users.maria,
      members: [users.maria, users.jonas],
      teams: [
        { id: 20, name: "Recruiting", slug: "recruiting", description: "Talent pipeline" },
        { id: 21, name: "Workplace", slug: "workplace", description: "Office & IT" },
      ],
    },
    {
      id: 3,
      documentId: "demodepartment0000000003",
      name: "Marketing",
      slug: "marketing",
      description: "Brand, growth and content.",
      color: "#f97316",
      head: users.sofia,
      members: [users.sofia],
      teams: [
        { id: 30, name: "Brand", slug: "brand", description: "Identity & campaigns" },
        { id: 31, name: "Growth", slug: "growth", description: "Paid and lifecycle" },
      ],
    },
  ] satisfies Department[];

  const teams: Team[] = departments.flatMap((d) =>
    d.teams.map((t) => ({
      ...t,
      department: departmentRef(d),
      lead: d.head,
      members: d.members,
    })),
  );

  return { departments, teams };
}
