import Link from "next/link";
import { ArrowLeft, Compass } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

/**
 * Root 404 (issue #33): only a not-found file at the app root catches
 * "any unmatched URLs for your whole application" — without it, dead
 * bookmarks and too-deep wiki paths rendered the unlocalized framework
 * 404 instead of the translated card the (app) group already had.
 * Renders inside the root layout (fonts, locale), deliberately without
 * the app shell — the URL may not belong to any signed-in area.
 */
export default async function RootNotFound() {
  const t = await getTranslations("errors");
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md animate-fade-in-up">
        <CardContent className="flex flex-col items-center justify-center gap-4 py-20 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Compass className="h-7 w-7" aria-hidden="true" />
          </div>
          <div className="space-y-1">
            <p className="text-lg font-semibold">{t("notFoundTitle")}</p>
            <p className="max-w-sm text-sm text-muted-foreground">{t("notFoundHint")}</p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/">
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden="true" />
              {t("backToDashboard")}
            </Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
