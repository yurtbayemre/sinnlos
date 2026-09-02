"use client";

import { useState, useActionState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { ImagePlus, X } from "lucide-react";
import {
  createClassified,
  updateClassified,
  type ClassifiedFormState,
} from "@/lib/classified-actions";
import {
  AD_CATEGORIES,
  AD_CATEGORY_KEYS,
  AD_DEFAULT_DURATION_DAYS,
  AD_DURATION_DAYS,
  AD_IMAGE_TYPES,
  MAX_AD_IMAGES,
  MAX_AD_IMAGE_BYTES,
  MAX_AD_IMAGE_MB,
} from "@/lib/classified-shared";
import type { ClassifiedCategory } from "@/lib/types";
import { SelectMenu } from "@/components/ui/select-menu";

const inputClass =
  "h-10 w-full rounded-xl border bg-muted/40 px-4 text-sm outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring";

export type ClassifiedFormInitial = {
  id: number;
  title: string;
  description: string;
  category: ClassifiedCategory;
  price: number | null;
  priceNegotiable: boolean;
  location: string;
  images: { id: number; url: string | null }[];
};

/**
 * Create/edit form for a marketplace ad (page form, profile-form pattern).
 * File checks here are UX only — the CMS re-validates count, size and the
 * real magic-byte MIME on the upload route.
 *
 * React 19 resets an uncontrolled <form action> after the action settles,
 * EVEN when it returns an error. The action therefore echoes the submitted
 * values back in the error state, and every uncontrolled field derives its
 * defaultValue from them — the reset then restores exactly what the user
 * typed. `category` and `days` are controlled (state, submitted via the
 * SelectMenu hidden inputs) and survive the reset natively; the file input
 * cannot be replayed (browser security), so its selection display is
 * cleared to match.
 */
export function ClassifiedForm({ initial }: { initial?: ClassifiedFormInitial }) {
  const t = useTranslations("marketplace");
  const tCommon = useTranslations("common");

  const action = initial ? updateClassified.bind(null, initial.id) : createClassified;
  const [state, formAction, isPending] = useActionState<ClassifiedFormState, FormData>(action, {});
  // Submitted values echoed back by a failed action — see doc comment.
  const v = state.values;

  const [category, setCategory] = useState<ClassifiedCategory>(initial?.category ?? "sale");
  // Editing keeps the current expiry ("") unless a new lifetime is picked.
  const [days, setDays] = useState<string>(initial ? "" : String(AD_DEFAULT_DURATION_DAYS));
  const [keptImages, setKeptImages] = useState(initial?.images ?? []);
  const [fileNames, setFileNames] = useState<string[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);

  // A failed submit still resets the native file input (files cannot be
  // echoed back) — drop the stale "selected files" display with it.
  // Compare-and-set during render (issue #36) instead of an effect.
  const [prevActionState, setPrevActionState] = useState(state);
  if (prevActionState !== state) {
    setPrevActionState(state);
    if (state.error) setFileNames([]);
  }

  const errorValues = { count: MAX_AD_IMAGES, size: MAX_AD_IMAGE_MB };
  const serverError = state.error
    ? // Error codes come from the action; map to translated messages.
      t(`error_${state.error}` as Parameters<typeof t>[0], errorValues)
    : null;

  const onFilesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const files = Array.from(input.files ?? []);
    let error: string | null = null;
    if (files.length + keptImages.length > MAX_AD_IMAGES) {
      error = t("error_imageCount", errorValues);
    } else if (files.some((f) => !AD_IMAGE_TYPES.includes(f.type))) {
      error = t("error_imageType", errorValues);
    } else if (files.some((f) => f.size > MAX_AD_IMAGE_BYTES)) {
      error = t("error_imageSize", errorValues);
    }
    if (error) {
      // Reject the whole selection so the submitted FileList stays valid.
      input.value = "";
      setFileNames([]);
      setFileError(error);
    } else {
      setFileNames(files.map((f) => f.name));
      setFileError(null);
    }
  };

  const showPrice = category !== "giveaway";

  return (
    <form action={formAction} className="max-w-2xl space-y-5">
      <div>
        <label htmlFor="ad-title" className="mb-1 block text-sm font-medium">
          {t("adTitle")}
        </label>
        <input
          id="ad-title"
          name="title"
          type="text"
          required
          maxLength={120}
          defaultValue={v ? v.title : (initial?.title ?? "")}
          placeholder={t("adTitlePlaceholder")}
          className={inputClass}
        />
      </div>

      <div>
        <span className="mb-1 block text-sm font-medium">{t("categoryLabel")}</span>
        <SelectMenu
          name="category"
          value={category}
          onChange={(next) => setCategory(next as ClassifiedCategory)}
          ariaLabel={t("categoryLabel")}
          buttonClassName="w-full"
          options={AD_CATEGORIES.map((c) => ({
            value: c,
            label: t(AD_CATEGORY_KEYS[c] as Parameters<typeof t>[0]),
          }))}
        />
      </div>

      <div>
        <label htmlFor="ad-description" className="mb-1 block text-sm font-medium">
          {t("descriptionLabel")}
        </label>
        <textarea
          id="ad-description"
          name="description"
          required
          maxLength={5000}
          rows={6}
          defaultValue={v ? v.description : (initial?.description ?? "")}
          placeholder={t("descriptionPlaceholder")}
          className="w-full rounded-xl border bg-muted/40 px-4 py-2.5 text-sm outline-none placeholder:text-muted-foreground focus:bg-background focus:ring-2 focus:ring-ring"
        />
      </div>

      {showPrice && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="ad-price" className="mb-1 block text-sm font-medium">
              {t("priceLabel")}
            </label>
            <input
              id="ad-price"
              name="price"
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              defaultValue={v ? v.price : (initial?.price ?? "")}
              className={`${inputClass} [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
            />
          </div>
          <label className="flex items-center gap-2 self-end pb-2.5 text-sm">
            <input
              type="checkbox"
              name="priceNegotiable"
              defaultChecked={v ? v.priceNegotiable : (initial?.priceNegotiable ?? false)}
              className="h-4 w-4 rounded border accent-primary"
            />
            {t("negotiableLabel")}
          </label>
        </div>
      )}

      <div>
        <label htmlFor="ad-location" className="mb-1 block text-sm font-medium">
          {t("locationLabel")}
        </label>
        <input
          id="ad-location"
          name="location"
          type="text"
          maxLength={120}
          defaultValue={v ? v.location : (initial?.location ?? "")}
          placeholder={t("locationPlaceholder")}
          className={inputClass}
        />
      </div>

      {keptImages.length > 0 && (
        <div>
          <span className="mb-1 block text-sm font-medium">{t("currentImages")}</span>
          <ul className="flex flex-wrap gap-3">
            {keptImages.map((img) => (
              <li key={img.id} className="relative">
                {/* Kept ids are re-submitted; removed ones simply drop off. */}
                <input type="hidden" name="keepImages" value={img.id} />
                {img.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={img.url} alt="" className="h-20 w-20 rounded-xl border object-cover" />
                ) : (
                  <div className="flex h-20 w-20 items-center justify-center rounded-xl border bg-muted">
                    <ImagePlus className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setKeptImages(keptImages.filter((k) => k.id !== img.id))}
                  aria-label={t("removeImage")}
                  className="absolute -right-2 -top-2 rounded-full border bg-background p-1 shadow outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <label htmlFor="ad-images" className="mb-1 block text-sm font-medium">
          {t("imagesLabel")}
        </label>
        <input
          id="ad-images"
          name="images"
          type="file"
          multiple
          accept={AD_IMAGE_TYPES.join(",")}
          onChange={onFilesChange}
          className="w-full rounded-xl border bg-muted/40 px-4 py-2 text-sm file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-primary/10 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary file:transition-colors file:hover:bg-primary/20"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {t("imagesHint", { count: MAX_AD_IMAGES, size: MAX_AD_IMAGE_MB })}
        </p>
        {fileNames.length > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {t("selectedFiles", { count: fileNames.length })}: {fileNames.join(", ")}
          </p>
        )}
        {fileError && (
          <p role="alert" className="mt-1 text-sm text-destructive">
            {fileError}
          </p>
        )}
      </div>

      <div>
        <span className="mb-1 block text-sm font-medium">{t("durationLabel")}</span>
        <SelectMenu
          name="days"
          value={days}
          onChange={setDays}
          ariaLabel={t("durationLabel")}
          buttonClassName="w-full"
          options={[
            ...(initial ? [{ value: "", label: t("durationUnchanged") }] : []),
            ...AD_DURATION_DAYS.map((d) => ({
              value: String(d),
              label: t("durationDays", { days: d }),
            })),
          ]}
        />
      </div>

      {serverError && (
        <p role="alert" className="text-sm text-destructive">
          {serverError}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={isPending}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
        >
          {isPending
            ? initial
              ? tCommon("saving")
              : t("publishing")
            : initial
              ? tCommon("save")
              : t("publish")}
        </button>
        <Link
          href={initial ? `/marketplace/${initial.id}` : "/marketplace"}
          className="rounded-xl border px-4 py-2.5 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          {tCommon("cancel")}
        </Link>
      </div>
    </form>
  );
}
