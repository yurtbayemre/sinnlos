import Link from "next/link";
import { ExternalLink, Shield, Users, BookOpen, Building2, Megaphone, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Admin" };

const STRAPI_URL = process.env.STRAPI_URL || "http://localhost:1337";

const roles = [
  {
    name: "Admin",
    description: "Full CRUD on everything. Manages users, roles and departments.",
    color: "bg-red-500/10 text-red-600 dark:text-red-400",
  },
  {
    name: "Editor",
    description: "CRUD on wiki pages and announcements. Read access to users.",
    color: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  {
    name: "Department Head",
    description: "Manages their own department, its teams and scoped wiki pages.",
    color: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
  },
  {
    name: "Team Lead",
    description: "CRUD on their own team pages, read elsewhere.",
    color: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  {
    name: "Member",
    description: "Read everything their role/department/team permits. Edits their profile.",
    color: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  {
    name: "Guest",
    description: "Read-only access to public wiki spaces.",
    color: "bg-slate-500/10 text-slate-600 dark:text-slate-400",
  },
];

const quickLinks = [
  { href: "/admin/content-manager", label: "Content Manager", icon: BookOpen, description: "Edit wiki pages, departments, teams and announcements." },
  { href: "/admin/settings/users-permissions/roles", label: "Roles & permissions", icon: Shield, description: "Configure what each role can read or write." },
  { href: "/admin/settings/users-permissions/users", label: "Users", icon: Users, description: "Review users synced from Microsoft Entra ID." },
  { href: "/admin/content-manager/collection-types/api::department.department", label: "Departments", icon: Building2, description: "Add or rename org units." },
  { href: "/admin/content-manager/collection-types/api::announcement.announcement", label: "Announcements", icon: Megaphone, description: "Post company-wide news." },
];

export default function AdminPage() {
  return (
    <div className="space-y-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Settings &amp; configuration</p>
          <h1 className="text-3xl font-semibold tracking-tight">Admin</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Content, users and roles are managed in the Strapi admin panel. This page
            surfaces the most common entry points so you don&apos;t have to remember them.
          </p>
        </div>
        <Button asChild>
          <a href={`${STRAPI_URL}/admin`} target="_blank" rel="noreferrer">
            Open Strapi admin
            <ExternalLink className="ml-2 h-4 w-4" />
          </a>
        </Button>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Quick links</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {quickLinks.map((link) => {
            const Icon = link.icon;
            return (
              <a
                key={link.href}
                href={`${STRAPI_URL}${link.href}`}
                target="_blank"
                rel="noreferrer"
                className="block"
              >
                <Card className="h-full transition hover:border-primary/40 hover:shadow-md">
                  <CardHeader>
                    <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" />
                    </div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      {link.label}
                      <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                    </CardTitle>
                    <CardDescription>{link.description}</CardDescription>
                  </CardHeader>
                </Card>
              </a>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Roles</h2>
        <p className="text-sm text-muted-foreground">
          Sinnlos ships with six roles. New Microsoft Entra ID users are assigned via
          group claims and the mapping in <code className="rounded bg-muted px-1.5 py-0.5 text-xs">config/ms-role-map.ts</code>.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {roles.map((r) => (
            <Card key={r.name}>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className={`flex h-9 w-9 items-center justify-center rounded-xl ${r.color}`}>
                    <Lock className="h-4 w-4" />
                  </div>
                  <CardTitle className="text-base">{r.name}</CardTitle>
                </div>
                <CardDescription className="pt-1">{r.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      <Card className="border-dashed">
        <CardContent className="flex flex-col gap-2 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="font-medium text-foreground">Need to change how Microsoft groups map to roles?</div>
            <div>
              Edit <code className="rounded bg-muted px-1.5 py-0.5 text-xs">apps/cms/config/ms-role-map.ts</code> and restart Strapi.
            </div>
          </div>
          <Button variant="outline" asChild>
            <Link href="/wiki/handbook/welcome">Read the handbook</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
