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
-- v0.34 was not, so the rollout reviews it:
--
--   a. Run this before the deploy and decide each row with the owner:
--      - section 1, every row (a reference to an admin-panel file): its
--        text's readers may open the file from v0.34 on, at once when
--        `linked = false`, and once the last linking row goes when
--        `linked = true` (until then the link's audience decides, and
--        readers outside it lose the image or link). Approve that audience
--        or remove the reference (a reference planted to a file of another
--        audience would open it). A row with `means = false` names a
--        rendition URL of this file that another file's original also has:
--        the name means that original today and this file once it is gone,
--        so decide it the same way;
--      - section 2, every row (a reference to an intranet upload): it opens
--        nothing from v0.34 on (only the linking row or the uploader does).
--        Accept the loss, or re-upload the file in the admin panel;
--      - section 3, every row (a reference to no stored file): remove it or
--        accept it as a dead link.
--   b. From that reviewed run until the new version is live, only admin_role
--      and editor write these texts (a freeze for everyone else). The deploy
--      brief runs this again in PRE: a row whose `updated_at` is newer than
--      the reviewed run stops the deploy until it is decided the same way.
--
--   1. inline_unstamped: references in a Markdown text (announcement body,
--      event description, wiki page body, wiki revision body, lesson body,
--      course description, department and team description) to admin-panel
--      files, linked or not, with the rows that link the file;
--   2. inline_stamped: references to files uploaded through the intranet;
--   3. unresolvable: references that name no stored file (dead links, or
--      another site's /uploads/ path): they open nothing;
--   4. unused_panel_files: admin-panel files that nothing links and no text
--      names: from v0.34 only admin_role and editor open them (the media
--      library's thumbnails);
--   5. summary: the counts.
--
-- A reference is `/uploads/<name>` up to ASCII whitespace, a quote, a
-- bracket, `/`, `\`, `?` or `#`, without trailing sentence punctuation,
-- matched exactly against the stored original and rendition URLs: the cms
-- reads it the same way (uploadReferenceNames, resolveUploadFile; an
-- original wins over another file's rendition of the same name).
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
         f.provider_metadata->>'uploadedBy' AS uploaded_by,
         'original' AS kind
    FROM files f
   WHERE f.url LIKE '/uploads/%'
  UNION
  SELECT f.id,
         f.name,
         substring(fmt.value->>'url' FROM '^/uploads/(.*)$'),
         f.provider_metadata->>'uploadedBy',
         'rendition'
    FROM files f
   CROSS JOIN LATERAL jsonb_each(coalesce(f.formats::jsonb, '{}'::jsonb)) AS fmt
   WHERE fmt.value->>'url' LIKE '/uploads/%'
), upload_resolved AS (
  -- The file a name means (resolveUploadFile): the original with that URL,
  -- else the one file listing it as a rendition (two such files: none).
  SELECT ref_name, file_id, file_name, uploaded_by
    FROM upload_names
   WHERE kind = 'original'
  UNION ALL
  SELECT n.ref_name, min(n.file_id), min(n.file_name), min(n.uploaded_by)
    FROM upload_names n
   WHERE n.kind = 'rendition'
     AND NOT EXISTS (SELECT 1 FROM upload_names o
                      WHERE o.kind = 'original' AND o.ref_name = n.ref_name)
   GROUP BY n.ref_name
  HAVING count(DISTINCT n.file_id) = 1
), upload_hosts AS (
  SELECT 'announcement' AS host, a.id AS row_id, a.document_id,
         CASE WHEN a.published_at IS NULL THEN 'draft' ELSE 'published' END AS status,
         'body' AS field, a.title AS label, a.updated_at, a.body AS text
    FROM announcements a
  UNION ALL
  SELECT 'event', e.id, e.document_id,
         CASE WHEN e.published_at IS NULL THEN 'draft' ELSE 'published' END,
         'description', e.title, e.updated_at, e.description
    FROM events e
  UNION ALL
  SELECT 'wiki-page', w.id, w.document_id,
         CASE WHEN w.published_at IS NULL THEN 'draft' ELSE 'published' END,
         'body', w.title, w.updated_at, w.body
    FROM wiki_pages w
  UNION ALL
  SELECT 'wiki-revision', r.id, r.page_document_id, 'history', 'body', r.title, r.updated_at,
         r.body
    FROM wiki_revisions r
  UNION ALL
  SELECT 'lesson', l.id, l.document_id,
         CASE WHEN l.published_at IS NULL THEN 'draft' ELSE 'published' END,
         'body', l.title, l.updated_at, l.body
    FROM lessons l
  UNION ALL
  SELECT 'course', c.id, c.document_id,
         CASE WHEN c.published_at IS NULL THEN 'draft' ELSE 'published' END,
         'description', c.title, c.updated_at, c.description
    FROM courses c
  UNION ALL
  SELECT 'department', d.id, d.document_id, 'single', 'description', d.name, d.updated_at,
         d.description
    FROM departments d
  UNION ALL
  SELECT 'team', t.id, t.document_id, 'single', 'description', t.name, t.updated_at,
         t.description
    FROM teams t
), upload_tokens AS (
  SELECT DISTINCT h.host, h.row_id, h.document_id, h.status, h.field, h.label, h.updated_at,
         regexp_replace(m.name[1], '[.,;:!]+$', '') AS ref_name
    FROM upload_hosts h
   CROSS JOIN LATERAL regexp_matches(coalesce(h.text, ''), '/uploads/([^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/"''<>()\[\]\x5c?#]+)', 'g')
         AS m(name)
), upload_refs AS (
  -- Every file that claims the name; `means`: the cms resolves it to this one.
  SELECT DISTINCT tok.host, tok.row_id, tok.document_id, tok.status, tok.field, tok.label,
         tok.updated_at, n.file_id, n.file_name, n.uploaded_by,
         EXISTS (SELECT 1 FROM upload_resolved r
                  WHERE r.ref_name = tok.ref_name AND r.file_id = n.file_id) AS means
    FROM upload_tokens tok
    JOIN upload_names n ON n.ref_name = tok.ref_name
), upload_links AS (
  SELECT r.file_id,
         string_agg(DISTINCT r.related_type || ' ' || r.related_id::text, ', ') AS linked_by
    FROM files_related_mph r
   GROUP BY r.file_id
), unresolvable AS (
  SELECT tok.*
    FROM upload_tokens tok
   WHERE tok.ref_name <> ''
     AND NOT EXISTS (SELECT 1 FROM upload_resolved n WHERE n.ref_name = tok.ref_name)
), unused AS (
  SELECT f.id AS file_id, f.name AS file_name
    FROM files f
   WHERE f.provider_metadata->>'uploadedBy' IS NULL
     AND NOT EXISTS (SELECT 1 FROM files_related_mph r WHERE r.file_id = f.id)
     AND NOT EXISTS (SELECT 1 FROM upload_refs ref WHERE ref.file_id = f.id AND ref.means)
)
-- Sections 1-4, one row per reference or file.
SELECT CASE WHEN ref.uploaded_by IS NULL THEN '1 inline_unstamped' ELSE '2 inline_stamped' END
         AS section,
       ref.host, ref.row_id, ref.document_id, ref.status, ref.field, ref.label, ref.updated_at,
       ref.file_id, ref.file_name, ref.uploaded_by, ref.means,
       l.file_id IS NOT NULL AS linked, l.linked_by
  FROM upload_refs ref
  LEFT JOIN upload_links l ON l.file_id = ref.file_id
UNION ALL
SELECT '3 unresolvable', u.host, u.row_id, u.document_id, u.status, u.field, u.label,
       u.updated_at, NULL, u.ref_name, NULL, NULL, NULL, NULL
  FROM unresolvable u
UNION ALL
SELECT '4 unused_panel_files', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       un.file_id, un.file_name, NULL, NULL, false, NULL
  FROM unused un
 ORDER BY section, file_id, host, row_id;

WITH upload_names AS (
  SELECT f.id AS file_id,
         f.name AS file_name,
         substring(f.url FROM '^/uploads/(.*)$') AS ref_name,
         f.provider_metadata->>'uploadedBy' AS uploaded_by,
         'original' AS kind
    FROM files f
   WHERE f.url LIKE '/uploads/%'
  UNION
  SELECT f.id,
         f.name,
         substring(fmt.value->>'url' FROM '^/uploads/(.*)$'),
         f.provider_metadata->>'uploadedBy',
         'rendition'
    FROM files f
   CROSS JOIN LATERAL jsonb_each(coalesce(f.formats::jsonb, '{}'::jsonb)) AS fmt
   WHERE fmt.value->>'url' LIKE '/uploads/%'
), upload_resolved AS (
  -- The file a name means (resolveUploadFile): the original with that URL,
  -- else the one file listing it as a rendition (two such files: none).
  SELECT ref_name, file_id, file_name, uploaded_by
    FROM upload_names
   WHERE kind = 'original'
  UNION ALL
  SELECT n.ref_name, min(n.file_id), min(n.file_name), min(n.uploaded_by)
    FROM upload_names n
   WHERE n.kind = 'rendition'
     AND NOT EXISTS (SELECT 1 FROM upload_names o
                      WHERE o.kind = 'original' AND o.ref_name = n.ref_name)
   GROUP BY n.ref_name
  HAVING count(DISTINCT n.file_id) = 1
), upload_texts AS (
  SELECT 'announcement' AS host, id AS row_id, body AS text FROM announcements
  UNION ALL SELECT 'event', id, description FROM events
  UNION ALL SELECT 'wiki-page', id, body FROM wiki_pages
  UNION ALL SELECT 'wiki-revision', id, body FROM wiki_revisions
  UNION ALL SELECT 'lesson', id, body FROM lessons
  UNION ALL SELECT 'course', id, description FROM courses
  UNION ALL SELECT 'department', id, description FROM departments
  UNION ALL SELECT 'team', id, description FROM teams
), upload_tokens AS (
  SELECT DISTINCT t.host, t.row_id, regexp_replace(m.name[1], '[.,;:!]+$', '') AS ref_name
    FROM upload_texts t
   CROSS JOIN LATERAL regexp_matches(coalesce(t.text, ''), '/uploads/([^\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff/"''<>()\[\]\x5c?#]+)', 'g')
         AS m(name)
), upload_refs AS (
  -- Every claimant, as listed in sections 1 and 2.
  SELECT DISTINCT tok.host, tok.row_id, n.file_id, n.uploaded_by,
         EXISTS (SELECT 1 FROM upload_resolved r
                  WHERE r.ref_name = tok.ref_name AND r.file_id = n.file_id) AS means
    FROM upload_tokens tok
    JOIN upload_names n ON n.ref_name = tok.ref_name
)
-- 5. The counts of sections 1-4 (a reference counts once per text row and file).
SELECT 'summary' AS section,
       (SELECT count(*) FROM upload_refs WHERE uploaded_by IS NULL) AS inline_unstamped,
       (SELECT count(*) FROM upload_refs ref
         WHERE ref.uploaded_by IS NULL
           AND NOT EXISTS (SELECT 1 FROM files_related_mph r WHERE r.file_id = ref.file_id))
         AS inline_unstamped_unlinked,
       (SELECT count(*) FROM upload_refs WHERE uploaded_by IS NOT NULL) AS inline_stamped,
       (SELECT count(*) FROM upload_tokens tok
         WHERE tok.ref_name <> ''
           AND NOT EXISTS (SELECT 1 FROM upload_resolved n WHERE n.ref_name = tok.ref_name))
         AS unresolvable,
       (SELECT count(*) FROM files f
         WHERE f.provider_metadata->>'uploadedBy' IS NULL
           AND NOT EXISTS (SELECT 1 FROM files_related_mph r WHERE r.file_id = f.id)
           AND NOT EXISTS (SELECT 1 FROM upload_refs ref WHERE ref.file_id = f.id AND ref.means))
         AS unused_panel_files;

ROLLBACK;
