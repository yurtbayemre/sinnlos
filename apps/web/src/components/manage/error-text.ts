import { useTranslations } from "next-intl";
import type { ManageArea } from "@/lib/manage/areas";
import { knownCode } from "@/lib/manage/errors";

/**
 * The text of a field's error code (deep-dive decision 06 §L7):
 * `manage.<area>.fields.<field>.<code>` when the area words it for that
 * field, else `manage.common.errors.<code>`. A code the web does not know
 * (a newer cms) reads as "invalid". Works in server and client components.
 * `scope`: a form of the area with its own field texts
 * (`manage.<area>.<scope>.fields`, the wiki editor's `editor`).
 */
export function useFieldErrorText(
  area: ManageArea,
  scope?: string,
): (field: string, code: string) => string {
  const t = useTranslations("manage");
  const fields = scope ? `${area}.${scope}.fields` : `${area}.fields`;
  return (field, code) => {
    const known = knownCode(code);
    // A dynamic key: the area's field-specific wording, when it exists.
    const specific = `${fields}.${field}.${known}` as Parameters<typeof t.has>[0];
    if (t.has(specific)) return t(specific);
    return t(`common.errors.${known}`);
  };
}
