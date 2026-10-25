/**
 * The document library (WD01). Per-user: document-visibility filters per
 * caller (department scoping) — same as wiki/people/announcements.
 * Uncached (D-DC01).
 */
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";
import type { Document } from "@/lib/types";

/** Documents per library page. */
export const DOCUMENTS_PAGE_SIZE = 100;

/**
 * One page of the library, newest change first (v0.30): the documents page
 * pages with prev/next. The old walk of every page stopped at 1,000
 * documents without saying so. Secondary sort on id keeps the pages stable
 * — `updatedAt` is not unique.
 */
export function listDocuments(page = 1): Promise<StrapiListResponse<Document>> {
  return strapi<StrapiListResponse<Document>>(
    withQuery(
      "/api/documents",
      strapiQuery()
        .populate("file")
        .populate("departments")
        .populate("uploadedBy")
        .sort(["updatedAt:desc", "id:desc"])
        .page(page, DOCUMENTS_PAGE_SIZE),
    ),
  );
}

/** A document that requires acknowledgement, with what its audience depends on. */
export type AckDocument = Pick<
  Document,
  "id" | "documentId" | "title" | "requiresAck" | "audience" | "departments"
>;

/**
 * The documents that require acknowledgement (v0.20): the dashboard banner
 * and, as admin_role (which bypasses document-visibility), the ack report.
 * requiresAck is a plain boolean attribute, so the filter validates for
 * every reading role. Full walk with the library's cap.
 */
export function listDocumentsRequiringAck(): Promise<WalkResult<AckDocument>> {
  return walkAllPages<AckDocument>(
    (page) =>
      strapi<StrapiListResponse<AckDocument>>(
        withQuery(
          "/api/documents",
          strapiQuery()
            .filter("requiresAck", "$eq", true)
            .fields(["title", "requiresAck", "audience"])
            .populateFields("departments", ["name"])
            .sort(["id:asc"])
            .page(page, 100),
        ),
      ),
    { maxPages: 10, label: "mandatory documents" },
  );
}
