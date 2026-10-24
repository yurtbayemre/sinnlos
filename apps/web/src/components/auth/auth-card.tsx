import { SiteFooter } from "@/components/layout/site-footer";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * The frame of the small auth pages (v0.27: /forgot-password,
 * /set-password, /mfa/setup): the sign-in page's background, one card and
 * the site footer. A server component; the forms inside are clients. The
 * card is the page's main landmark, the footer stays outside it (S6).
 */
export function AuthCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-linear-to-br from-background via-background to-primary/5 p-6">
      <Card role="main" className="w-full max-w-md shadow-lg">
        <CardHeader className="text-center">
          <CardTitle as="h1" className="text-2xl">
            {title}
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
      <SiteFooter className="relative mt-6" />
    </div>
  );
}
