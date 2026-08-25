import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { api } from "@/lib/strapi";
import { tryFetch } from "@/lib/safe-fetch";
import { PageHeader } from "@/components/page-header";
import { PollForm } from "@/components/polls/poll-form";

const POLL_CREATOR_ROLES = new Set(["admin_role", "editor"]);

export async function generateMetadata() {
  const t = await getTranslations("polls");
  return { title: t("newPoll") };
}

export default async function NewPollPage() {
  const session = await auth();
  const role = session?.user?.role;
  if (!role || !POLL_CREATOR_ROLES.has(role)) redirect("/polls");

  const t = await getTranslations("polls");
  const { data } = await tryFetch(() => api.departments.list(), "departments");
  const departments = ((data?.data ?? []) as { id: number; name: string }[]).map((d) => ({
    id: d.id,
    name: d.name,
  }));

  return (
    <div className="space-y-8">
      <PageHeader title={t("newPoll")} description={t("newPollDescription")} />
      <PollForm departments={departments} />
    </div>
  );
}
