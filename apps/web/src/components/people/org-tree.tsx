"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Card, CardContent } from "@/components/ui/card";
import { initials } from "@/lib/utils";
import type { UserLite } from "@/lib/types";

type PersonNode = UserLite & { managerId?: number | null; children: PersonNode[] };

function buildTree(people: (UserLite & { manager?: { id: number } | null })[]) {
  const map = new Map<number, PersonNode>();
  for (const p of people) {
    map.set(p.id, { ...p, managerId: p.manager?.id ?? null, children: [] });
  }
  const roots: PersonNode[] = [];
  for (const node of map.values()) {
    if (node.managerId && map.has(node.managerId)) {
      map.get(node.managerId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function OrgTree({
  people,
}: {
  people: (UserLite & { manager?: { id: number } | null })[];
}) {
  const roots = useMemo(() => buildTree(people), [people]);

  if (roots.length === 0) return null;

  return (
    <div className="space-y-2">
      {roots.map((node) => (
        <TreeNode key={node.id} node={node} level={0} />
      ))}
    </div>
  );
}

function TreeNode({ node, level }: { node: PersonNode; level: number }) {
  const [expanded, setExpanded] = useState(level < 2);
  const hasChildren = node.children.length > 0;
  const name = node.displayName ?? node.username ?? node.email ?? "Unknown";
  const avatarUrl = node.avatar?.url ?? null;

  return (
    <div style={{ marginLeft: level > 0 ? 24 : 0 }}>
      <Card className="mb-1">
        <CardContent className="flex items-center gap-3 p-3">
          {hasChildren ? (
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition hover:bg-muted"
              aria-label={expanded ? "Collapse" : "Expand"}
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
            href={`/people/${node.id}`}
            className="flex items-center gap-3 transition hover:opacity-80"
          >
            <Avatar className="h-9 w-9">
              {avatarUrl ? <AvatarImage src={avatarUrl} alt={name} /> : null}
              <AvatarFallback className="text-xs">
                {initials(name)}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{name}</div>
              {node.jobTitle && (
                <div className="truncate text-xs text-muted-foreground">
                  {node.jobTitle}
                </div>
              )}
            </div>
          </Link>
          {node.department?.name && (
            <span className="ml-auto hidden text-xs text-muted-foreground sm:inline">
              {node.department.name}
            </span>
          )}
        </CardContent>
      </Card>
      {hasChildren && expanded && (
        <div className="border-l border-border/50 ml-3 pl-0">
          {node.children.map((child) => (
            <TreeNode key={child.id} node={child} level={level + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
