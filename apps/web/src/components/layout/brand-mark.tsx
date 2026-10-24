import { cn } from "@/lib/utils";

/**
 * The instance's mark (v0.29, S1): its logo (SITE_LOGO_URL), else the first
 * letter of its name on the accent fill. Decorative in both forms: the name
 * stands next to it. `className` sets the size and the corner radius.
 */
export function BrandMark({
  name,
  logoUrl,
  className,
}: {
  name: string;
  logoUrl: string | null;
  className?: string;
}) {
  if (logoUrl) {
    // An operator-hosted https URL; next/image is not configured (no
    // remotePatterns), and the referrer stays with the intranet.
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt=""
        referrerPolicy="no-referrer"
        className={cn("object-contain", className)}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex items-center justify-center bg-primary font-bold text-primary-foreground",
        className,
      )}
    >
      {[...name][0]!.toUpperCase()}
    </div>
  );
}
