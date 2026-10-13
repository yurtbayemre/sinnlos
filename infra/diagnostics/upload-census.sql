-- Upload census (READ-ONLY; batch 16, lane 16A).
--
-- What the files table holds before and after the batch-16 deploy, which
-- opens POST /api/upload to PDF, DOCX, XLSX and PPTX for moderators and
-- department heads and lets the nightly uploads-janitor sweep their
-- unattached uploads (deep-dive decision 06 §E1-§E5):
--   1. by_type: files per stored mime and extension, with their size;
--   2. stamps: stamped files (uploaded through POST /api/upload, with
--      provider_metadata.uploadedBy), unstamped ones (admin-panel uploads,
--      never removed by the app) and tombstoned ones (a removal claimed them;
--      the janitor retries them after 10 minutes);
--   3. janitor_candidates: stamped files that nothing links, older than
--      24 hours or tombstoned: the uploads-janitor's next sweep (03:30);
--   4. shared_files: files linked by more than one document or ad (a panel
--      clone shares its source's file; anything else is unusual);
--   5. legacy_document_files: documents whose file has a mime outside the
--      document list (PDF, DOCX, XLSX, PPTX, JPEG, PNG, WebP). They keep their
--      file (keeping is not attaching); a new attachment must be on the list.
--
-- Expected on production before batch 16: the two demo PDFs, unstamped;
-- 0 janitor candidates.
--
--   docker exec -i infra-db-1 sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < infra/diagnostics/upload-census.sql
--
-- The output names files, documents and ads (ids, names, titles) and the
-- uploader's user id, no contact data; it is internal operational data, do
-- not post it publicly.
--
-- Pure SQL, no psql meta-commands: the integration suite upload-profile
-- runs this file against Postgres 16 as it is.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- 1. Files per stored mime and extension (size: core stores kilobytes).
SELECT 'by_type' AS section,
       mime,
       ext,
       count(*) AS files,
       round(coalesce(sum(size), 0) / 1024, 1) AS total_mb
  FROM files
 GROUP BY mime, ext
 ORDER BY count(*) DESC, mime, ext;

-- 2. Stamped, unstamped, tombstoned.
SELECT 'stamps' AS section,
       count(*) FILTER (WHERE provider_metadata->>'uploadedBy' IS NOT NULL) AS stamped,
       count(*) FILTER (WHERE provider_metadata->>'uploadedBy' IS NULL) AS unstamped,
       count(*) FILTER (WHERE provider_metadata->>'removing' IS NOT NULL) AS tombstoned
  FROM files;

-- 3. The janitor's next candidates (it re-checks each under the row lock).
SELECT 'janitor_candidates' AS section,
       f.id AS file_id,
       f.name,
       f.mime,
       f.created_at,
       f.provider_metadata->>'uploadedBy' AS uploaded_by,
       f.provider_metadata->>'removing' AS tombstoned_at
  FROM files f
 WHERE f.provider_metadata->>'uploadedBy' IS NOT NULL
   AND (f.created_at < now() - interval '24 hours'
        OR f.provider_metadata->>'removing' IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM files_related_mph r WHERE r.file_id = f.id)
 ORDER BY f.id;

-- 4. Files linked by more than one document or ad (a document's draft and
--    published rows count as one document).
WITH links AS (
  SELECT r.file_id,
         r.related_type || ' ' || coalesce(d.document_id, c.document_id, 'row ' || r.related_id::text)
           AS owner
    FROM files_related_mph r
    LEFT JOIN documents d
           ON r.related_type = 'api::document.document' AND d.id = r.related_id
    LEFT JOIN classifieds c
           ON r.related_type = 'api::classified.classified' AND c.id = r.related_id
)
SELECT 'shared_files' AS section,
       file_id,
       count(DISTINCT owner) AS owners,
       string_agg(DISTINCT owner, ', ') AS linked_by
  FROM links
 GROUP BY file_id
HAVING count(DISTINCT owner) > 1
 ORDER BY file_id;

-- 5. Documents whose file is outside the document list (legacy, kept).
SELECT 'legacy_document_files' AS section,
       d.document_id,
       d.title,
       CASE WHEN d.published_at IS NULL THEN 'draft' ELSE 'published' END AS status,
       f.id AS file_id,
       f.mime,
       f.ext
  FROM documents d
  JOIN files_related_mph r
    ON r.related_type = 'api::document.document' AND r.related_id = d.id AND r.field = 'file'
  JOIN files f ON f.id = r.file_id
 WHERE f.mime NOT IN (
         'application/pdf',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation',
         'image/jpeg',
         'image/png',
         'image/webp')
 ORDER BY d.document_id, status;

ROLLBACK;
