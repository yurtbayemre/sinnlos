"use server";

/**
 * Marketplace (classifieds) server actions. Image files travel through the
 * action as FormData (the Next server then talks to Strapi), because the
 * browser never holds the Strapi JWT. Two-step write:
 *
 *   1. POST /api/upload (multipart, user JWT) → media ids. The CMS
 *      enforces JPEG/PNG/WebP magic bytes, 5 MB and max 4 files per
 *      request on that route.
 *   2. POST/PUT /api/classifieds with data.images = ids. The CMS pins the
 *      author server-side and clamps expiresAt to [today, +90 days].
 *
 * Error contract: actions return machine codes (ClassifiedErrorCode); the
 * form translates them (i18n rule — no user-facing strings here).
 *
 * Orphan handling (issue #13): if step 2 fails after step 1 succeeded (or
 * an update deselects images), the action best-effort POSTs the ids to
 * /api/classifieds/cleanup-uploads — the CMS only deletes files the caller
 * uploaded (provider_metadata.uploadedBy) that hang on no ad. Failures are
 * ignored on purpose: the CMS-side nightly janitor
 * (apps/cms/src/cron/sweep-orphaned-uploads.ts) is the actual safety net,
 * and deleting an ad removes its images via the classified delete
 * lifecycle. Employees still hold no generic upload.destroy permission.
 */
import { refresh } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { auth } from "@/auth";
import { DEMO_MODE, STRAPI_URL } from "@/lib/config";
import { strapi } from "@/lib/strapi";
import {
  AD_DEFAULT_DURATION_DAYS,
  AD_IMAGE_TYPES,
  MAX_AD_IMAGES,
  MAX_AD_IMAGE_BYTES,
  dateInDays,
  isClassifiedCategory,
} from "@/lib/classified-shared";

export type ClassifiedErrorCode =
  | "missingFields"
  | "invalidPrice"
  | "imageCount"
  | "imageType"
  | "imageSize"
  | "failed";

/**
 * Raw (untrimmed/unparsed) field values as submitted. Returned alongside
 * every error so the form can replay them: React 19 resets an uncontrolled
 * <form action> after the action settles — even on an error return — which
 * would otherwise wipe everything the user typed. File inputs cannot be
 * replayed (browser security), only the text/choice fields are.
 */
export type ClassifiedFormValues = {
  title: string;
  description: string;
  category: string;
  price: string;
  priceNegotiable: boolean;
  location: string;
  days: string;
};

export type ClassifiedFormState = {
  error?: ClassifiedErrorCode;
  values?: ClassifiedFormValues;
};

function rawFormValues(formData: FormData): ClassifiedFormValues {
  return {
    title: String(formData.get("title") ?? ""),
    description: String(formData.get("description") ?? ""),
    category: String(formData.get("category") ?? ""),
    price: String(formData.get("price") ?? ""),
    priceNegotiable: formData.get("priceNegotiable") === "on",
    location: String(formData.get("location") ?? ""),
    days: String(formData.get("days") ?? ""),
  };
}

type ParsedAdForm = {
  fields: {
    title: string;
    description: string;
    category: string;
    price: number | null;
    priceNegotiable: boolean;
    location: string;
  };
  files: File[];
  keepImageIds: number[];
  /** Requested lifetime in days from today, or null = leave unchanged. */
  days: number | null;
};

function parseAdForm(formData: FormData): { error: ClassifiedErrorCode } | ParsedAdForm {
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const category = String(formData.get("category") ?? "");
  if (!title || !description || !isClassifiedCategory(category)) {
    return { error: "missingFields" };
  }

  let price: number | null = null;
  const priceRaw = String(formData.get("price") ?? "").trim();
  if (priceRaw) {
    const parsed = Number(priceRaw.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed < 0) return { error: "invalidPrice" };
    price = Math.round(parsed * 100) / 100;
  }

  const files = formData.getAll("images").filter((f): f is File => f instanceof File && f.size > 0);
  const keepImageIds = formData
    .getAll("keepImages")
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (files.length + keepImageIds.length > MAX_AD_IMAGES) return { error: "imageCount" };
  for (const file of files) {
    // Declared type only — the CMS re-verifies via magic bytes.
    if (!AD_IMAGE_TYPES.includes(file.type)) return { error: "imageType" };
    if (file.size > MAX_AD_IMAGE_BYTES) return { error: "imageSize" };
  }

  const daysRaw = String(formData.get("days") ?? "").trim();
  const daysParsed = daysRaw ? Number(daysRaw) : NaN;
  const days = Number.isInteger(daysParsed) && daysParsed > 0 ? daysParsed : null;

  return {
    fields: {
      title,
      description,
      category,
      price,
      priceNegotiable: formData.get("priceNegotiable") === "on",
      location: String(formData.get("location") ?? "").trim(),
    },
    files,
    keepImageIds,
    days,
  };
}

/** Multipart upload to Strapi — strapi() always sends JSON, hence raw fetch. */
async function uploadAdImages(files: File[]): Promise<number[]> {
  if (files.length === 0 || DEMO_MODE) return [];
  const session = await auth();
  const token = session?.strapiJwt;
  if (!token) throw new Error("Not authenticated");

  const body = new FormData();
  for (const file of files) body.append("files", file, file.name);

  const res = await fetch(`${STRAPI_URL}/api/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Strapi upload ${res.status}: ${await res.text()}`);
  }
  const uploaded = (await res.json()) as Array<{ id: number }>;
  return uploaded.map((f) => f.id);
}

/**
 * Best-effort orphan cleanup (issue #13): ask the CMS to drop the given
 * upload ids. Server-side it only deletes files the CALLER uploaded
 * (provider_metadata.uploadedBy) that are attached to nothing, so stale or
 * foreign ids are harmless. Real errors are swallowed — the nightly CMS
 * janitor is the net —, only NEXT_REDIRECT (401 → sign-in) propagates.
 */
async function cleanupOrphanedUploads(imageIds: number[]): Promise<void> {
  if (imageIds.length === 0 || DEMO_MODE) return;
  try {
    await strapi("/api/classifieds/cleanup-uploads", {
      method: "POST",
      body: JSON.stringify({ imageIds }),
      noCache: true,
    });
  } catch (e) {
    unstable_rethrow(e);
    console.error("[classifieds] upload cleanup failed", e);
  }
}

/** Image ids currently attached to an ad — [] when the lookup fails. */
async function currentImageIds(id: number): Promise<number[]> {
  try {
    const res = await strapi<{ data: Array<{ images?: Array<{ id: number }> }> }>(
      `/api/classifieds?filters[id][$eq]=${id}&populate[images][fields][0]=id`,
      { noCache: true },
    );
    return (res.data?.[0]?.images ?? []).map((img) => img.id);
  } catch (e) {
    unstable_rethrow(e);
    // Non-fatal: without the old list we simply skip the deselect cleanup
    // (janitor territory) instead of failing the update.
    return [];
  }
}

export async function createClassified(
  _prev: ClassifiedFormState,
  formData: FormData,
): Promise<ClassifiedFormState> {
  // Captured up front: every error return must carry the submitted values
  // so the form survives React 19's post-action reset (see type above).
  const values = rawFormValues(formData);
  const parsed = parseAdForm(formData);
  if ("error" in parsed) return { error: parsed.error, values };

  // Hoisted out of the try: the catch needs the ids of a SUCCESSFUL step 1
  // to clean up after a failed step 2 (issue #13).
  let imageIds: number[] = [];
  try {
    imageIds = await uploadAdImages(parsed.files);
    await strapi("/api/classifieds", {
      method: "POST",
      body: JSON.stringify({
        data: {
          ...parsed.fields,
          images: imageIds,
          expiresAt: dateInDays(parsed.days ?? AD_DEFAULT_DURATION_DAYS),
        },
      }),
      noCache: true,
    });
  } catch (e) {
    // strapi()'s 401 → sign-in redirect (NEXT_REDIRECT) must propagate.
    unstable_rethrow(e);
    console.error("[classifieds] create failed", e);
    // Step 1 succeeded, step 2 failed: sweep the just-uploaded images.
    await cleanupOrphanedUploads(imageIds);
    return { error: "failed", values };
  }
  refresh();
  redirect("/marketplace");
}

export async function updateClassified(
  id: number,
  _prev: ClassifiedFormState,
  formData: FormData,
): Promise<ClassifiedFormState> {
  // Same value replay as createClassified (React 19 post-action reset).
  const values = rawFormValues(formData);
  const parsed = parseAdForm(formData);
  if ("error" in parsed) return { error: parsed.error, values };

  // The form only submits the KEPT ids — fetch the ad's current images
  // first so deselected ones can be cleaned up after a successful update.
  const previousImageIds = await currentImageIds(id);

  let newImageIds: number[] = [];
  try {
    newImageIds = await uploadAdImages(parsed.files);
    const data: Record<string, unknown> = {
      ...parsed.fields,
      images: [...parsed.keepImageIds, ...newImageIds],
    };
    // Only touch the expiry when the user explicitly picked a new lifetime.
    if (parsed.days !== null) data.expiresAt = dateInDays(parsed.days);

    await strapi(`/api/classifieds/${id}`, {
      method: "PUT",
      body: JSON.stringify({ data }),
      noCache: true,
    });
  } catch (e) {
    unstable_rethrow(e);
    console.error("[classifieds] update failed", e);
    // Same orphan case as in create: fresh uploads whose PUT never landed.
    await cleanupOrphanedUploads(newImageIds);
    return { error: "failed", values };
  }
  // Deselected images now hang on nothing — sweep the caller's own ones.
  // (For a moderator edit the ids belong to the ad's author, so the CMS
  // skips them and the nightly janitor takes over.)
  await cleanupOrphanedUploads(
    previousImageIds.filter((imgId) => !parsed.keepImageIds.includes(imgId)),
  );
  refresh();
  redirect(`/marketplace/${id}`);
}

export async function deleteClassified(id: number): Promise<{ error?: "failed" }> {
  try {
    await strapi(`/api/classifieds/${id}`, { method: "DELETE", noCache: true });
  } catch (e) {
    unstable_rethrow(e);
    console.error("[classifieds] delete failed", e);
    return { error: "failed" };
  }
  refresh();
  return {};
}

/** Re-arm an (expired) ad for another 30 days — a plain ownership-gated update. */
export async function renewClassified(id: number): Promise<{ error?: "failed" }> {
  try {
    await strapi(`/api/classifieds/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        data: { expiresAt: dateInDays(AD_DEFAULT_DURATION_DAYS) },
      }),
      noCache: true,
    });
  } catch (e) {
    unstable_rethrow(e);
    console.error("[classifieds] renew failed", e);
    return { error: "failed" };
  }
  refresh();
  return {};
}
