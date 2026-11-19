import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import type { UserName } from "@/lib/api/org";
import type { DepartmentChart as Chart, DepartmentChartTeam } from "@/lib/org-tree";
import { cn, displayNameOf } from "@/lib/utils";

const linkClass =
  "rounded-md outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/**
 * The org chart's department view (v1.1): nested lists, department (h2) →
 * its teams (h3), each with its head or lead and the member count. Static
 * markup, fully expanded, so it works without JavaScript; the tree of
 * reporting lines stays the default view (org-tree.tsx). The lists carry
 * role="list": Tailwind removes their markers, and VoiceOver then stops
 * announcing them as lists.
 */
export function DepartmentChart({ chart }: { chart: Chart }) {
  const t = useTranslations("people");
  return (
    <ul role="list" className="space-y-4">
      {chart.departments.map((department) => (
        <li key={department.id}>
          <Card className="mb-1">
            <CardContent className="p-3">
              <h2 className="text-base font-semibold">
                <Link href={`/departments/${department.slug}`} className={linkClass}>
                  {department.name}
                </Link>
              </h2>
              <Person label={t("deptHead")} none={t("deptNoHead")} person={department.head} />
            </CardContent>
          </Card>
          {department.teams.length > 0 ? (
            <Teams teams={department.teams} />
          ) : (
            <p className="ml-6 text-sm text-muted-foreground">{t("deptNoTeams")}</p>
          )}
        </li>
      ))}
      {chart.unassigned.length > 0 && (
        <li>
          <h2 className="mb-1 text-base font-semibold">{t("deptUnassigned")}</h2>
          <Teams teams={chart.unassigned} />
        </li>
      )}
    </ul>
  );
}

function Teams({ teams }: { teams: DepartmentChartTeam[] }) {
  const t = useTranslations("people");
  return (
    <ul role="list" className="ml-3 space-y-1 border-l border-border/50 pl-6">
      {teams.map((team) => (
        <li key={team.id}>
          <Card>
            <CardContent className="p-3">
              <h3 className="text-sm font-medium">
                <Link href={`/teams/${team.slug}`} className={linkClass}>
                  {team.name}
                </Link>
              </h3>
              <Person label={t("deptLead")} none={t("deptNoLead")} person={team.lead} />
              <p className="text-xs text-muted-foreground">
                {t("deptMembers", { count: team.memberCount })}
              </p>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

/** "Label: name" with the name linking to the profile, or `none` when nobody is set. */
function Person({ label, none, person }: { label: string; none: string; person: UserName | null }) {
  return (
    <p className="text-xs text-muted-foreground">
      {person ? (
        <>
          {label}:{" "}
          {/* Underlined: a name inside a sentence is not recognisable as a link without hover. */}
          <Link
            href={`/people/${person.id}`}
            className={cn(linkClass, "underline underline-offset-2")}
          >
            {displayNameOf(person, "Unknown")}
          </Link>
        </>
      ) : (
        none
      )}
    </p>
  );
}
