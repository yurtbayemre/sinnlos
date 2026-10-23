import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import QRCode from "qrcode";
import { AuthCard } from "@/components/auth/auth-card";
import { MfaSetupForm } from "@/components/auth/mfa-setup-form";
import { signOutAction } from "@/lib/auth-actions";
import { getSession } from "@/lib/session";
import { strapi } from "@/lib/strapi";
import { StrapiError } from "@/lib/strapi-error";

export async function generateMetadata() {
  const t = await getTranslations("mfa");
  return { title: t("title") };
}

// Every visit seals a new enrollment; nothing here may be cached.
export const dynamic = "force-dynamic";

type MeMfa = { data?: { mfa?: { enrolled?: boolean; restricted?: boolean } | null } | null };
type Setup = { data?: { secret?: string; otpauthUri?: string; enrollment?: string } | null };

/**
 * v0.27: turn the second factor on. A restricted session (its role needs
 * one, none enrolled yet) is sent here from every app page and may only
 * use /api/me and the setup routes, so this page reads nothing else and
 * lives outside the (app) layout, whose gate would send it here again.
 * The QR code is rendered on the server (no remote service).
 */
export default async function MfaSetupPage() {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  // A company account's second factor belongs to its identity provider.
  if (session.provider !== "local") redirect("/");
  const t = await getTranslations("mfa");

  const me = await strapi<MeMfa>("/api/me");
  const enrolled = me?.data?.mfa?.enrolled === true;
  const restricted = me?.data?.mfa?.restricted === true;

  let setup: Setup["data"] = null;
  if (!enrolled) {
    try {
      setup = (await strapi<Setup>("/api/me/mfa/setup", { method: "POST" }))?.data ?? null;
    } catch (error) {
      if (!(error instanceof StrapiError)) throw error;
      console.warn(`[mfa] setup refused: ${error.status} ${String(error.strapiDetails?.code ?? "")}`);
    }
  }
  const { secret, otpauthUri, enrollment } = setup ?? {};
  const ready = Boolean(secret && otpauthUri && enrollment);
  const qr = ready ? await QRCode.toDataURL(otpauthUri!, { margin: 1, width: 220 }) : "";

  // The activation's Server Action re-renders this page with the new
  // session (now enrolled): the form must stay at the same place in the
  // tree, so its state with the recovery codes survives. The `&&` holes
  // keep the positions; the form itself shows "already on" when enrolled.
  return (
    <AuthCard title={t("title")} description={t(restricted ? "descRequired" : "descVoluntary")}>
      {ready && <p className="text-sm">{t("step1")}</p>}
      {ready && (
        // eslint-disable-next-line @next/next/no-img-element -- an inline data URL, nothing to optimise
        <img
          src={qr}
          alt={t("qrAlt")}
          width={220}
          height={220}
          className="mx-auto rounded-lg border bg-white p-2"
        />
      )}
      {ready && (
        <p className="text-sm text-muted-foreground">
          {t("manualEntry")}{" "}
          <code className="break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
            {secret}
          </code>
        </p>
      )}
      {ready || enrolled ? (
        <MfaSetupForm key="mfa-setup" enrollment={enrollment ?? ""} enrolled={enrolled} />
      ) : (
        <p role="alert" className="text-sm text-destructive">
          {t("error_unavailable")}
        </p>
      )}
      {restricted && (
        <form action={signOutAction} className="text-center">
          <button type="submit" className="text-sm text-muted-foreground hover:underline">
            {t("signOut")}
          </button>
        </form>
      )}
    </AuthCard>
  );
}
