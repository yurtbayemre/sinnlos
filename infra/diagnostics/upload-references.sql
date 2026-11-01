-- Upload references in Markdown (READ-ONLY; v0.34, audit finding B1).
--
-- From v0.34 a file under /uploads opens only for whoever may read the
-- content it belongs to (apps/cms/src/utils/upload-access.ts): a file a row
-- links (a document's file, an ad's image, a course cover, a department
-- header, an avatar) only through that row; a file nothing links for its
-- uploader, and, when it is an admin-panel upload (no
-- provider_metadata.uploadedBy), through a Markdown text the reader may read
-- that names it (`/uploads/<name>` of the file or one of its renditions).
-- New references are checked when they are written; what was written before
-- v0.34 was not. Run this BEFORE the deploy, review every row of section 1
-- (a reference planted to a file of another audience would open it), and
-- again right before the deploy (the deploy brief's PRE): only rows that
-- were reviewed may stay.
--
--   1. inline_unstamped: every reference in a Markdown text (announcement
--      body, event description, wiki page body, wiki revision body, lesson
--      body, course description, department and team description) to an
--      admin-panel file, linked or not, with the rows that link it. A row
--      with `linked = false` opens the file for the text's readers from
--      v0.34 on; with `linked = true` it does not (the link decides) until
--      the last link goes;
--   2. inline_stamped: references to files uploaded through the intranet
--      (stamped). They never open a file from v0.34 on: a reader sees it only
--      through the row that links it (or as its uploader);
--   3. unresolvable: references that name no stored file (dead links, or
--      another site's /uploads/ path): they open nothing;
--   4. unused_panel_files: admin-panel files that nothing links and no text
--      names: from v0.34 only admin_role and editor open them (the media
--      library's thumbnails);
--   5. summary: the counts of 1-4.
--
-- Text matching is by substring, so a row may appear for a longer name that
-- starts with a listed one; the cms decides by the exact name.
--
--   docker exec -i infra-db-1 sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < infra/diagnostics/upload-references.sql
--
-- The output names files and content (ids, titles, file names) and the
-- uploader's user id, no contact data; it is internal operational data, do
-- not post it publicly.
--
-- Pure SQL, no psql meta-commands: the integration suite upload-access runs
-- this file against Postgres 16 as it is.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '60s';

WITH upload_names AS (
  SELECT f.id AS file_id,
         f.name AS file_name,
         substring(f.url FROM '^/uploads/(.*)$') AS ref_name,
         f.provider_metadata->>'uploadedBy' AS uploaded_by
    FROM files f
   WHERE f.url LIKE '/uploads/%'
  UNION
  SELECT f.id,
         f.name,
         substring(fmt.value->>'url' FROM '^/uploads/(.*)$'),
         f.provider_metadata->>'uploadedBy'
    FROM files f
   CROSS JOIN LATERAL jsonb_each(coalesce(f.formats::jsonb, '{}'::jsonb)) AS fmt
   WHERE fmt.value->>'url' LIKE '/uploads/%'
), upload_hosts AS (
  SELECT 'announcement' AS host, a.id AS row_id, a.document_id,
         CASE WHEN a.published_at IS NULL THEN 'draft' ELSE 'published' END AS status,
         'body' AS field, a.title AS label, a.body AS text
    FROM announcements a
  UNION ALL
  SELECT 'event', e.id, e.document_id,
         CASE WHEN e.published_at IS NULL THEN 'draft' ELSE 'published' END,
         'description', e.title, e.description
    FROM events e
  UNION ALL
  SELECT 'wiki-page', w.id, w.document_id,
         CASE WHEN w.published_at IS NULL THEN 'draft' ELSE 'published' END,
         'body', w.title, w.body
    FROM wiki_pages w
  UNION ALL
  SELECT 'wiki-revision', r.id, r.page_document_id, 'history', 'body', r.title, r.body
    FROM wiki_revisions r
  UNION ALL
  SELECT 'lesson', l.id, l.document_id,
         CASE WHEN l.published_at IS NULL THEN 'draft' ELSE 'published' END,
         'body', l.title, l.body
    FROM lessons l
  UNION ALL
  SELECT 'course', c.id, c.document_id,
         CASE WHEN c.published_at IS NULL THEN 'draft' ELSE 'published' END,
         'description', c.title, c.description
    FROM courses c
  UNION ALL
  SELECT 'department', d.id, d.document_id, 'single', 'description', d.name, d.description
    FROM departments d
  UNION ALL
  SELECT 'team', t.id, t.document_id, 'single', 'description', t.name, t.description
    FROM teams t
), upload_refs AS (
  SELECT DISTINCT h.host, h.row_id, h.document_id, h.status, h.field, h.label,
         n.file_id, n.file_name, n.uploaded_by
    FROM upload_hosts h
    JOIN upload_names n
      ON h.text IS NOT NULL
     AND position('/uploads/' || n.ref_name IN h.text) > 0
), upload_links AS (
  SELECT r.file_id,
         string_agg(DISTINCT r.related_type || ' ' || r.related_id::text, ', ') AS linked_by
    FROM files_related_mph r
   GROUP BY r.file_id
), unused AS (
  SELECT f.id AS file_id, f.name AS file_name
    FROM files f
   WHERE f.provider_metadata->>'uploadedBy' IS NULL
     AND NOT EXISTS (SELECT 1 FROM files_related_mph r WHERE r.file_id = f.id)
     AND NOT EXISTS (SELECT 1 FROM upload_refs ref WHERE ref.file_id = f.id)
), unresolvable AS (
  SELECT h.host, h.row_id, h.document_id, h.status, h.field, h.label,
         regexp_replace(m.name[1], '[.,;:!]+$', '') AS ref_name
    FROM upload_hosts h
   CROSS JOIN LATERAL regexp_matches(coalesce(h.text, ''), '/uploads/([^\s/"''<>()\[\]\x5c?#]+)', 'g')
         AS m(name)
   WHERE NOT EXISTS (
           SELECT 1 FROM upload_names n
            WHERE n.ref_name = regexp_replace(m.name[1], '[.,;:!]+$', ''))
)
-- Sections 1-4, one row per reference or file.
SELECT CASE WHEN ref.uploaded_by IS NULL THEN '1 inline_unstamped' ELSE '2 inline_stamped' END
         AS section,
       ref.host, ref.row_id, ref.document_id, ref.status, ref.field, ref.label,
       ref.file_id, ref.file_name, ref.uploaded_by,
       l.file_id IS NOT NULL AS linked, l.linked_by
  FROM upload_refs ref
  LEFT JOIN upload_links l ON l.file_id = ref.file_id
UNION ALL
SELECT '3 unresolvable', u.host, u.row_id, u.document_id, u.status, u.field, u.label,
       NULL, u.ref_name, NULL, NULL, NULL
  FROM unresolvable u
UNION ALL
SELECT '4 unused_panel_files', NULL, NULL, NULL, NULL, NULL, NULL,
       un.file_id, un.file_name, NULL, false, NULL
  FROM unused un
 ORDER BY section, file_id, host, row_id;

WITH upload_names AS (
  SELECT f.id AS file_id,
         f.name AS file_name,
         substring(f.url FROM '^/uploads/(.*)$') AS ref_name,
         f.provider_metadata->>'uploadedBy' AS uploaded_by
    FROM files f
   WHERE f.url LIKE '/uploads/%'
  UNION
  SELECT f.id,
         f.name,
         substring(fmt.value->>'url' FROM '^/uploads/(.*)$'),
         f.provider_metadata->>'uploadedBy'
    FROM files f
   CROSS JOIN LATERAL jsonb_each(coalesce(f.formats::jsonb, '{}'::jsonb)) AS fmt
   WHERE fmt.value->>'url' LIKE '/uploads/%'
), upload_hosts AS (
  SELECT 'announcement' AS host, a.id AS row_id, a.document_id,
         CASE WHEN a.published_at IS NULL THEN 'draft' ELSE 'published' END AS status,
         'body' AS field, a.title AS label, a.body AS text
    FROM announcements a
  UNION ALL
  SELECT 'event', e.id, e.document_id,
         CASE WHEN e.published_at IS NULL THEN 'draft' ELSE 'published' END,
         'description', e.title, e.description
    FROM events e
  UNION ALL
  SELECT 'wiki-page', w.id, w.document_id,
         CASE WHEN w.published_at IS NULL THEN 'draft' ELSE 'published' END,
         'body', w.title, w.body
    FROM wiki_pages w
  UNION ALL
  SELECT 'wiki-revision', r.id, r.page_document_id, 'history', 'body', r.title, r.body
    FROM wiki_revisions r
  UNION ALL
  SELECT 'lesson', l.id, l.document_id,
         CASE WHEN l.published_at IS NULL THEN 'draft' ELSE 'published' END,
         'body', l.title, l.body
    FROM lessons l
  UNION ALL
  SELECT 'course', c.id, c.document_id,
         CASE WHEN c.published_at IS NULL THEN 'draft' ELSE 'published' END,
         'description', c.title, c.description
    FROM courses c
  UNION ALL
  SELECT 'department', d.id, d.document_id, 'single', 'description', d.name, d.description
    FROM departments d
  UNION ALL
  SELECT 'team', t.id, t.document_id, 'single', 'description', t.name, t.description
    FROM teams t
), upload_refs AS (
  SELECT DISTINCT h.host, h.row_id, h.document_id, h.status, h.field, h.label,
         n.file_id, n.file_name, n.uploaded_by
    FROM upload_hosts h
    JOIN upload_names n
      ON h.text IS NOT NULL
     AND position('/uploads/' || n.ref_name IN h.text) > 0
), upload_links AS (
  SELECT r.file_id,
         string_agg(DISTINCT r.related_type || ' ' || r.related_id::text, ', ') AS linked_by
    FROM files_related_mph r
   GROUP BY r.file_id
), unused AS (
  SELECT f.id AS file_id, f.name AS file_name
    FROM files f
   WHERE f.provider_metadata->>'uploadedBy' IS NULL
     AND NOT EXISTS (SELECT 1 FROM files_related_mph r WHERE r.file_id = f.id)
     AND NOT EXISTS (SELECT 1 FROM upload_refs ref WHERE ref.file_id = f.id)
), unresolvable AS (
  SELECT h.host, h.row_id, h.document_id, h.status, h.field, h.label,
         regexp_replace(m.name[1], '[.,;:!]+$', '') AS ref_name
    FROM upload_hosts h
   CROSS JOIN LATERAL regexp_matches(coalesce(h.text, ''), '/uploads/([^\s/"''<>()\[\]\x5c?#]+)', 'g')
         AS m(name)
   WHERE NOT EXISTS (
           SELECT 1 FROM upload_names n
            WHERE n.ref_name = regexp_replace(m.name[1], '[.,;:!]+$', ''))
)
-- 5. The counts.
SELECT 'summary' AS section,
       (SELECT count(*) FROM upload_refs WHERE uploaded_by IS NULL) AS inline_unstamped,
       (SELECT count(*) FROM upload_refs ref
         WHERE ref.uploaded_by IS NULL
           AND NOT EXISTS (SELECT 1 FROM upload_links l WHERE l.file_id = ref.file_id))
         AS inline_unstamped_unlinked,
       (SELECT count(*) FROM upload_refs WHERE uploaded_by IS NOT NULL) AS inline_stamped,
       (SELECT count(*) FROM unresolvable) AS unresolvable,
       (SELECT count(*) FROM unused) AS unused_panel_files;

ROLLBACK;
