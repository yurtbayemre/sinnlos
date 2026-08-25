import Link from "next/link";
import { ArrowLeft, Compass } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default async function NotFound() {
  const t = await getTranslations("errors");
  return (
    <Card className="animate-fade-in-up">
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
  );
}
