"use client";

import { useState, useMemo } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { initials } from "@/lib/utils";
import { avatarThumbUrl } from "@/lib/config";
import { buildOrgTree, type OrgNode } from "@/lib/org-tree";
import type { UserLite } from "@/lib/types";

type OrgPersonLite = UserLite & { manager?: { id: number } | null };
type PersonNode = OrgNode<OrgPersonLite>;

/**
 * The org chart. The tree comes from lib/org-tree.ts (FX49): every person
 * appears once; people whose manager chain loops back, and people set as
 * their own manager, are extra roots with a warning, so an admin can fix
 * the manager field instead of the chart losing them (or never finishing
 * rendering).
 */
export function OrgTree({ people }: { people: OrgPersonLite[] }) {
  const t = useTranslations("people");
  const { roots, issues } = useMemo(() => buildOrgTree(people), [people]);

  if (roots.length === 0) return null;

  return (
    <div className="space-y-2">
      {issues > 0 && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t("orgChartIssues", { count: issues })}</span>
        </div>
      )}
      {roots.map((node) => (
        <TreeNode key={node.person.id} node={node} level={0} />
      ))}
    </div>
  );
}

function TreeNode({ node, level }: { node: PersonNode; level: number }) {
  const t = useTranslations("people");
  const [expanded, setExpanded] = useState(level < 2);
  const hasChildren = node.children.length > 0;
  const person = node.person;
  const name = person.displayName ?? person.username ?? person.email ?? "Unknown";
  const avatarUrl = avatarThumbUrl(person.avatar);

  return (
    <div style={{ marginLeft: level > 0 ? 24 : 0 }}>
      <Card className="mb-1">
        <CardContent className="flex items-center gap-3 p-3">
          {hasChildren ? (
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              aria-expanded={expanded}
              aria-label={t("expand")}
            >
              {expanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
          ) : (
            <div className="w-6" />
          )}
          <Link
            href={`/people/${person.id}`}
            className="flex items-center gap-3 rounded-lg outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            <Avatar className="h-9 w-9">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={name} /> : null}
              <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{name}</div>
              {person.jobTitle && (
                <div className="truncate text-xs text-muted-foreground">{person.jobTitle}</div>
              )}
              {node.issue && (
                <div className="flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                  {node.issue === "cycle" ? t("orgCycle") : t("orgSelfManager")}
                </div>
              )}
            </div>
          </Link>
          {person.department?.name && (
            <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
              {person.department.name}
            </span>
          )}
        </CardContent>
      </Card>
      {hasChildren && expanded && (
        <div className="border-l border-border/50 ml-3 pl-0">
          {node.children.map((child) => (
            <TreeNode key={child.person.id} node={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
