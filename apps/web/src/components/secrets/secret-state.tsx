import { useTranslations } from "next-intl";
import type { SecretShareSummary } from "@sinnlos/domain";

/**
 * A share's state in words, with its time: when a pending one expires (and
 * that it cannot be opened right now while a party is not eligible), when
 * an ended one ended. "Retrieved" means an authorised open attempt of the
 * recipient consumed it, never that a human read it.
 */
export function SecretState({
  share,
  when,
}: {
  share: SecretShareSummary;
  when: (iso: string | null) => string;
}) {
  const t = useTranslations("secrets.state");
  if (share.state === "pending") {
    return (
      <span>
        {t("pending", { when: when(share.expiresAt) })}
        {!share.available && ` · ${t("unavailable")}`}
      </span>
    );
  }
  return <span>{t(share.state, { when: when(share.terminalAt) })}</span>;
}
