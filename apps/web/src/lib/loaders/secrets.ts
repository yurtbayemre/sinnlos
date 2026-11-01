import { notFound, unstable_rethrow } from "next/navigation";
import {
  SECRET_SENT_MAX_PAGE,
  type SecretShareDetail,
  type SecretShareList,
} from "@sinnlos/domain";
import { isDocumentId } from "@/lib/entry-id";
import { strapi, StrapiError, type StrapiDataResponse } from "@/lib/strapi";

/**
 * The reads of the secret pages (v0.35): metadata only, never a text. A
 * failure logs its status alone, like the actions (lib/secret-share-errors.ts):
 * a StrapiError's message holds the upstream body. A 404 (an unknown share,
 * not the caller's, or the module off in the cms) is the 404 page.
 */
async function read(label: string, path: string): Promise<unknown> {
  try {
    return (await strapi<StrapiDataResponse<unknown>>(path))?.data;
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof StrapiError && error.status === 404) notFound();
    console.warn(`[secrets] ${label} failed: ${error instanceof StrapiError ? error.status : "-"}`);
    return undefined;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `?sentPage=` as the cms takes it: 1 to SECRET_SENT_MAX_PAGE, else 1. */
export function sentPageOf(value: unknown): number {
  const page = typeof value === "string" && /^[1-9]\d{0,2}$/.test(value) ? Number(value) : 1;
  return page <= SECRET_SENT_MAX_PAGE ? page : 1;
}

/** The caller's received and sent shares, or null when the read failed. */
export async function loadSecretList(sentPage: number): Promise<SecretShareList | null> {
  const data = await read("list", `/api/secret-shares?sentPage=${sentPage}`);
  return isRecord(data) && Array.isArray(data.received) && Array.isArray(data.sent)
    ? (data as unknown as SecretShareList)
    : null;
}

/**
 * One share of the caller. A malformed id is a 404 without a request; a
 * failed read throws a fixed error for (app)/error.tsx (Next logs its
 * message, which holds nothing of the answer).
 */
export async function loadSecretDetail(id: string): Promise<SecretShareDetail> {
  if (!isDocumentId(id)) notFound();
  const data = await read("detail", `/api/secret-shares/${id}`);
  if (isRecord(data) && data.id === id) return data as unknown as SecretShareDetail;
  throw new Error("[secrets] the share could not be read");
}
