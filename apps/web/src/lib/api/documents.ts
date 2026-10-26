/**
 * The document library (WD01). Per-user: document-visibility filters per
 * caller (department scoping) — same as wiki/people/announcements.
 * Uncached (D-DC01).
 */
import { ACK_REPORT_PAGE_SIZE } from "@/lib/ack-report";
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
 * One page of the documents that require acknowledgement (v0.20), for the
 * ack report as admin_role, which bypasses document-visibility (v0.31: the
 * report pages, ACK_REPORT_PAGE_SIZE items; the old walk stopped at 1,000).
 * requiresAck is a plain boolean attribute, so the filter validates for
 * every reading role.
 */
export function ackReportDocumentsPage(page: number): Promise<StrapiListResponse<AckDocument>> {
  return strapi<StrapiListResponse<AckDocument>>(
    withQuery(
      "/api/documents",
      strapiQuery()
        .filter("requiresAck", "$eq", true)
        .fields(["title", "requiresAck", "audience"])
        .populateFields("departments", ["name"])
        .sort(["id:asc"])
        .page(page, ACK_REPORT_PAGE_SIZE),
    ),
  );
}
