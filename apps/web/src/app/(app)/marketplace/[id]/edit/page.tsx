import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { getSession } from "@/lib/session";
import { api } from "@/lib/strapi";
import { getViewer } from "@/lib/viewer";
import { mediaUrl } from "@/lib/config";
import { parseRowId } from "@/lib/entry-id";
import { canEditAnyAd } from "@/lib/roles";
import type { Classified } from "@/lib/types";
import { PageHeader } from "@/components/page-header";
import { ClassifiedForm } from "@/components/marketplace/classified-form";
import { DeleteClassified } from "@/components/marketplace/delete-classified";

export async function generateMetadata() {
  const t = await getTranslations("marketplace");
  return { title: t("formTitleEdit") };
}

/**
 * Detail-page error strategy (WD07, same on all detail pages): a malformed
 * or unknown id is a 404; a failed read goes to (app)/error.tsx, whose
 * "Try again" fetches the page again.
 */
export default async function EditClassifiedPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // A malformed id never reaches the CMS: Postgres answers the filters[id]
  // lookup with an error, i.e. a 500 instead of a 404.
  const rowId = parseRowId(id) ?? notFound();
  const [t, session, viewer] = await Promise.all([
    getTranslations("marketplace"),
    getSession(),
    getViewer(),
  ]);

  const res = await api.classifieds.one(String(rowId));
  const ad = (res.data?.[0] ?? null) as Classified | null;
  if (!ad) notFound();

  // UI gate mirroring the CMS is-classified-author policy (owner, or the
  // update bypass, canEditAnyAd = admin_role; editors take ads down on the
  // detail page but do not edit them) — the CMS enforces it
  // authoritatively via the update-route policy config.
  const isOwner = typeof session?.user?.id === "number" && ad.author?.id === session.user.id;
  if (!isOwner && !canEditAnyAd(viewer.role)) {
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
