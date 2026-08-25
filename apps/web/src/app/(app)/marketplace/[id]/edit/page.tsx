import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { auth } from "@/auth";
import { api } from "@/lib/strapi";
import { mediaUrl } from "@/lib/config";
import { tryFetch } from "@/lib/safe-fetch";
import { isAdmin } from "@/lib/roles";
import type { Classified } from "@/lib/types";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { ClassifiedForm } from "@/components/marketplace/classified-form";
import { DeleteClassified } from "@/components/marketplace/delete-classified";

export async function generateMetadata() {
  const t = await getTranslations("marketplace");
  return { title: t("formTitleEdit") };
}

export default async function EditClassifiedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [t, session] = await Promise.all([getTranslations("marketplace"), auth()]);

  const { data, failed } = await tryFetch(() => api.classifieds.one(id), "classified-edit");
  const ad = (data?.data?.[0] ?? null) as Classified | null;
  if (!ad && !failed) notFound();
  if (!ad) {
    return (
      <div className="space-y-6">
        <FetchErrorBanner />
      </div>
    );
  }

  // UI gate mirroring the CMS is-classified-author policy (owner, or
  // admin bypass; editors may only delete, not edit) — the CMS enforces it
  // authoritatively via the update-route policy config.
  const role = session?.user?.role;
  const isOwner = typeof session?.user?.id === "number" && ad.author?.id === session.user.id;
  if (!isOwner && !isAdmin(role)) {
    redirect(`/marketplace/${ad.id}`);
  }

  const initial = {
    id: ad.id,
    title: ad.title,
    description: ad.description ?? "",
    category: ad.category ?? ("sale" as const),
    price: ad.price ?? null,
    priceNegotiable: ad.priceNegotiable ?? false,
    location: ad.location ?? "",
    images: (ad.images ?? []).map((img) => ({
      id: img.id,
      url: mediaUrl(img.formats?.thumbnail?.url ?? img.url ?? null),
    })),
  };

  return (
    <div className="space-y-8">
      <Link
        href={`/marketplace/${ad.id}`}
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t("backToAd")}
      </Link>
      <PageHeader title={t("formTitleEdit")} description={ad.title}>
        <DeleteClassified id={ad.id} title={ad.title} />
      </PageHeader>
      <ClassifiedForm initial={initial} />
    </div>
  );
}
