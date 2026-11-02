import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import { formatInstant } from "@/lib/date-format";
import { loadSecretDetail } from "@/lib/loaders/secrets";
import { isReadDenied } from "@/lib/roles";
import { canReceiveSecrets } from "@/lib/secret-roles";
import { getViewer } from "@/lib/viewer";
import { PageHeader } from "@/components/page-header";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { Card, CardContent } from "@/components/ui/card";
import { RevealSecret } from "@/components/secrets/reveal-secret";
import { RevokeSecret } from "@/components/secrets/revoke-secret";
import { SecretState } from "@/components/secrets/secret-state";

export async function generateMetadata() {
  const t = await getTranslations("secrets");
  return { title: t("title") };
}

const WHEN = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } as const;

/**
 * One secret (v0.35), for its sender or its recipient; anything else is the
 * 404 page. Rendering it never opens the secret: the recipient's text comes
 * only from the "Show and delete" click (RevealSecret), never from this
 * page's server render, a prefetch or a reload.
 */
export default async function SecretPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, t, tCommon, format, viewer] = await Promise.all([
    params,
    getTranslations("secrets"),
    getTranslations("common"),
    getFormatter(),
    getViewer(),
  ]);
  if (isReadDenied(viewer.role, "secrets")) {
    return <SectionUnavailablePage title={t("title")} />;
  }
  const share = await loadSecretDetail(id);
  const name = share.counterpart?.displayName ?? tCommon("unknown");
  const when = (iso: string | null) => formatInstant(format, iso, WHEN) ?? "";
  const received = share.direction === "received";
  // v0.36: a recipient outside SECRETS_RECEIVE_ROLES sees the share as not
  // available, without the reveal (the cms says so too, and refuses the open).
  const shown =
    received && !canReceiveSecrets(viewer.role) ? { ...share, available: false } : share;

  return (
    <div className="space-y-8">
      <Link
        href="/secrets"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t("back")}
      </Link>
      <PageHeader
        title={received ? t("fromName", { name }) : t("toName", { name })}
        description={t("sentAt", { when: when(share.createdAt) })}
      />
      <Card>
        <CardContent className="space-y-4 p-6">
          <p className="text-sm">
            <SecretState share={shown} when={when} />
          </p>
          {received && shown.state === "pending" && shown.available && (
            <RevealSecret id={share.id} />
          )}
          {!received && share.state === "pending" && <RevokeSecret id={share.id} />}
        </CardContent>
      </Card>
    </div>
  );
}
