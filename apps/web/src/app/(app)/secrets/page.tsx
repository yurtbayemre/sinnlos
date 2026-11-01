import Link from "next/link";
import type { Route } from "next";
import { Inbox, KeyRound, Plus, Send } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import type { SecretShareSummary } from "@sinnlos/domain";
import { formatInstant } from "@/lib/date-format";
import { loadSecretList, sentPageOf } from "@/lib/loaders/secrets";
import { isReadDenied } from "@/lib/roles";
import { getViewer } from "@/lib/viewer";
import { EmptyState } from "@/components/empty-state";
import { FetchErrorBanner } from "@/components/fetch-error";
import { PageHeader } from "@/components/page-header";
import { SectionUnavailablePage } from "@/components/section-unavailable";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionLabel } from "@/components/ui/section-label";
import { RevokeSecret } from "@/components/secrets/revoke-secret";
import { SecretState } from "@/components/secrets/secret-state";

export async function generateMetadata() {
  const t = await getTranslations("secrets");
  return { title: t("title") };
}

const WHEN = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } as const;

/**
 * /secrets (v0.35): the pending secrets for the viewer, the secrets the
 * viewer sent (newest first, `?sentPage=`) and "New secret". Metadata only:
 * no text is ever read here.
 */
export default async function SecretsPage({
  searchParams,
}: {
  searchParams: Promise<{ sentPage?: string | string[] }>;
}) {
  const [t, tCommon, format, viewer, params] = await Promise.all([
    getTranslations("secrets"),
    getTranslations("common"),
    getFormatter(),
    getViewer(),
    searchParams,
  ]);
  // Guests and the `authenticated` fallback hold no secret-share grant (SH02).
  if (isReadDenied(viewer.role, "secrets")) {
    return <SectionUnavailablePage title={t("title")} description={t("description")} />;
  }
  const sentPage = sentPageOf(params.sentPage);
  const list = await loadSecretList(sentPage);
  const when = (iso: string | null) => formatInstant(format, iso, WHEN) ?? "";
  const name = (share: SecretShareSummary) => share.counterpart?.displayName ?? tCommon("unknown");

  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("description")}>
        <Button asChild>
          <Link href="/secrets/new">
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("new")}
          </Link>
        </Button>
      </PageHeader>

      {!list && <FetchErrorBanner />}

      <section className="space-y-3">
        <SectionLabel icon={Inbox}>{t("received")}</SectionLabel>
        {list && list.received.length === 0 ? (
          <EmptyState icon={KeyRound} title={t("receivedEmpty")} />
        ) : (
          <div className="space-y-2">
            {list?.received.map((share) => (
              <Card key={share.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4">
                  <Link
                    href={`/secrets/${share.id}` as Route}
                    className="font-medium hover:underline"
                  >
                    {t("fromName", { name: name(share) })}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {t("expires", { when: when(share.expiresAt) })}
                  </span>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <SectionLabel icon={Send}>{t("sent")}</SectionLabel>
        {list && list.sent.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("sentEmpty")}</p>
        ) : (
          <div className="space-y-2">
            {list?.sent.map((share) => (
              <Card key={share.id}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div className="min-w-0 space-y-1">
                    <Link
                      href={`/secrets/${share.id}` as Route}
                      className="font-medium hover:underline"
                    >
                      {t("toName", { name: name(share) })}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {t("sentAt", { when: when(share.createdAt) })} ·{" "}
                      <SecretState share={share} when={when} />
                    </div>
                  </div>
                  {share.state === "pending" && <RevokeSecret id={share.id} />}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        {list && (sentPage > 1 || list.hasMore) && (
          <nav className="flex gap-4 text-sm" aria-label={t("sentPages")}>
            {sentPage > 1 && (
              <Link href={`/secrets?sentPage=${sentPage - 1}` as Route} className="hover:underline">
                {t("newer")}
              </Link>
            )}
            {list.hasMore && (
              <Link href={`/secrets?sentPage=${sentPage + 1}` as Route} className="hover:underline">
                {t("older")}
              </Link>
            )}
          </nav>
        )}
      </section>
    </div>
  );
}
