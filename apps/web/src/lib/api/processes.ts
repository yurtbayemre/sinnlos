/**
 * Processes (v1.1 "Tools", BPMN). Every staff role reads the published
 * processes (published-only; guests hold no grant). Uncached like the duty
 * plans. The LIST reads metadata only (title, summary, department,
 * updatedAt): the diagram is up to ~700 KiB per process and only the detail
 * read fetches it, so a list of 500 never moves hundreds of megabytes.
 */
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";
import type { Process } from "@/lib/types";

/** Every published process without its diagram, by title; hard cap 5 x 100. */
export function listProcesses(): Promise<WalkResult<Process>> {
  return walkAllPages<Process>(
    (page) =>
      strapi<StrapiListResponse<Process>>(
        withQuery(
          "/api/processes",
          strapiQuery()
            .fields(["title", "summary", "updatedAt"])
            .populateFields("department", ["name", "slug"])
            .sort(["title:asc", "id:asc"])
            .page(page, 100),
        ),
      ),
    { maxPages: 5, label: "processes" },
  );
}

/** One published process with its diagram, by documentId (an empty list: not found). */
export function processByDocumentId(documentId: string): Promise<StrapiListResponse<Process>> {
  return strapi<StrapiListResponse<Process>>(
    withQuery(
      "/api/processes",
      strapiQuery()
        .filter("documentId", "$eq", documentId)
        .fields(["title", "summary", "diagram", "updatedAt"])
        .populateFields("department", ["name", "slug"])
        .page(1, 1),
    ),
  );
}
