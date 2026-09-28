/**
 * The document library (WD01). Per-user: document-visibility filters per
 * caller (department scoping) — same as wiki/people/announcements.
 * Uncached (D-DC01).
 */
import { walkAllPages, type WalkResult } from "@/lib/paginate";
import { strapi, type StrapiListResponse } from "@/lib/strapi/client";
import { strapiQuery, withQuery } from "@/lib/strapi/query";
import type { Document } from "@/lib/types";

/**
 * Walks every page (issue #26 follow-up): the documents page is a complete
 * library grouped by category with no pagination UI, so the old pageSize=50
 * render cap silently hid document #51+. Secondary sort on id keeps the
 * walk stable — `updatedAt` is not unique. Hard cap: 10 pages x 100 = 1000
 * documents.
 */
export function listDocuments(): Promise<WalkResult<Document>> {
  return walkAllPages<Document>(
    (page) =>
      strapi<StrapiListResponse<Document>>(
        withQuery(
          "/api/documents",
          strapiQuery()
            .populate("file")
            .populate("departments")
            .populate("uploadedBy")
            .sort(["updatedAt:desc", "id:desc"])
            .page(page, 100),
        ),
      ),
    { maxPages: 10, label: "documents" },
  );
}
