-- wiki-revision-dp PREFLIGHT (Postgres only; READ ONLY, changes nothing).
--
-- Shows what infra/migrations/wiki-revision-dp/migrate.sql would do to
-- wiki_revisions before the release that switches draftAndPublish off for
-- wiki-revision (batch 16, decision 06 §J4 and Migration §2). Runbook:
-- docs/DEPLOYMENT.md "One-time: wiki revisions draft/publish off", notes in
-- infra/migrations/wiki-revision-dp/README.md. Safe while the current
-- release is live:
--   docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
--     exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < infra/migrations/wiki-revision-dp/preflight.sql
-- Non-default DATABASE_SCHEMA: add  -v schema=<name>  to the psql call.
--
-- Runs on both schemas: before the first batch-16 deploy (wiki_revisions
-- without the batch-16 columns) and after a rollback to batch 15.1 (the
-- columns are there, NULL on every row 15.1 wrote; to_jsonb() reads them
-- when they exist and as NULL when they do not).
--
-- FAST PATH: R0 draft_rows = 0 means there is nothing to migrate; deploy
-- normally (infra/deploy.sh).
-- Must be 0 before migrate.sql can succeed: R1 divergent twins, R2
-- conflicts, R4 (every line).
-- Keep the output: R3 is the per-page baseline the verification after the
-- deploy (and after a rollback) compares with.

\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
\if :{?schema}
SET LOCAL search_path TO :"schema";
\endif

SELECT to_regclass('wiki_revisions') IS NOT NULL AS has_revisions \gset
\if :has_revisions

\echo '== R0 draft rows (FAST PATH when draft_rows = 0)'
\echo '   draft_rows | published_rows | documents'
SELECT count(*) FILTER (WHERE published_at IS NULL) AS draft_rows,
       count(*) FILTER (WHERE published_at IS NOT NULL) AS published_rows,
       count(DISTINCT document_id) AS documents
  FROM wiki_revisions;

\echo '== R1 the draft rows by class (migrate.sql: draft-only PROMOTED, identical twin DELETED, divergent twin STOPS)'
\echo '   identical twin: a draft whose published row of the same document_id has the same body and summary,'
\echo '   links the same page documents and the same editor, and whose batch-16 columns are NULL. A rollback'
\echo '   to batch 15.1 (or older) makes one for every revision; anything else is divergent.'
\echo '   class | rows'
WITH page_docs AS (
  SELECT l.wiki_revision_id AS rev, string_agg(DISTINCT p.document_id, ',' ORDER BY p.document_id) AS docs
    FROM wiki_revisions_page_lnk l JOIN wiki_pages p ON p.id = l.wiki_page_id
   GROUP BY l.wiki_revision_id
), editors AS (
  SELECT wiki_revision_id AS rev, string_agg(DISTINCT user_id::text, ',' ORDER BY user_id::text) AS users
    FROM wiki_revisions_editor_lnk GROUP BY wiki_revision_id
), classified AS (
  SELECT d.id, pub.id AS pub_id,
         concat_ws(', ',
           CASE WHEN d.body IS DISTINCT FROM pub.body THEN 'body' END,
           CASE WHEN d.summary IS DISTINCT FROM pub.summary THEN 'summary' END,
           CASE WHEN dp.docs IS DISTINCT FROM pp.docs THEN 'page' END,
           CASE WHEN de.users IS DISTINCT FROM pe.users THEN 'editor' END,
           CASE WHEN jsonb_strip_nulls(to_jsonb(d) - ARRAY['id', 'document_id', 'body', 'summary',
                       'created_at', 'updated_at', 'published_at', 'created_by_id', 'updated_by_id',
                       'locale']) <> '{}'::jsonb
                THEN 'batch-16 columns' END) AS differs
    FROM wiki_revisions d
    LEFT JOIN LATERAL (SELECT p.* FROM wiki_revisions p
                        WHERE p.document_id = d.document_id AND p.published_at IS NOT NULL
                        ORDER BY p.id LIMIT 1) pub ON true
    LEFT JOIN page_docs dp ON dp.rev = d.id
    LEFT JOIN page_docs pp ON pp.rev = pub.id
    LEFT JOIN editors de ON de.rev = d.id
    LEFT JOIN editors pe ON pe.rev = pub.id
   WHERE d.published_at IS NULL
)
SELECT CASE WHEN pub_id IS NULL THEN 'draft-only'
            WHEN differs = '' THEN 'identical twin'
            ELSE 'divergent twin' END AS class,
       count(*) AS rows
  FROM classified GROUP BY 1 ORDER BY 1;

\echo '== R1 divergent twins (must be 0: resolve each per the README, then rerun) and draft-only rows'
\echo '   class | id | document_id | differs in | body (first 60 characters)'
WITH page_docs AS (
  SELECT l.wiki_revision_id AS rev, string_agg(DISTINCT p.document_id, ',' ORDER BY p.document_id) AS docs
    FROM wiki_revisions_page_lnk l JOIN wiki_pages p ON p.id = l.wiki_page_id
   GROUP BY l.wiki_revision_id
), editors AS (
  SELECT wiki_revision_id AS rev, string_agg(DISTINCT user_id::text, ',' ORDER BY user_id::text) AS users
    FROM wiki_revisions_editor_lnk GROUP BY wiki_revision_id
), classified AS (
  SELECT d.id, d.document_id, d.body, pub.id AS pub_id,
         concat_ws(', ',
           CASE WHEN d.body IS DISTINCT FROM pub.body THEN 'body' END,
           CASE WHEN d.summary IS DISTINCT FROM pub.summary THEN 'summary' END,
           CASE WHEN dp.docs IS DISTINCT FROM pp.docs THEN 'page' END,
           CASE WHEN de.users IS DISTINCT FROM pe.users THEN 'editor' END,
           CASE WHEN jsonb_strip_nulls(to_jsonb(d) - ARRAY['id', 'document_id', 'body', 'summary',
                       'created_at', 'updated_at', 'published_at', 'created_by_id', 'updated_by_id',
                       'locale']) <> '{}'::jsonb
                THEN 'batch-16 columns' END) AS differs
    FROM wiki_revisions d
    LEFT JOIN LATERAL (SELECT p.* FROM wiki_revisions p
                        WHERE p.document_id = d.document_id AND p.published_at IS NOT NULL
                        ORDER BY p.id LIMIT 1) pub ON true
    LEFT JOIN page_docs dp ON dp.rev = d.id
    LEFT JOIN page_docs pp ON pp.rev = pub.id
    LEFT JOIN editors de ON de.rev = d.id
    LEFT JOIN editors pe ON pe.rev = pub.id
   WHERE d.published_at IS NULL
)
SELECT CASE WHEN pub_id IS NULL THEN 'draft-only' ELSE 'divergent twin' END AS class,
       id, document_id, CASE WHEN pub_id IS NULL THEN '' ELSE differs END AS differs,
       left(coalesce(body, ''), 60) AS body
  FROM classified
 WHERE pub_id IS NULL OR differs <> ''
 ORDER BY 1, id;

\echo '== R2 page anchors per revision document (conflicts must be 0; orphans keep a NULL anchor, no history reaches them)'
\echo '   A document anchored by page_document_id (batch 16) keeps it; any other is anchored by the page'
\echo '   documents its link rows reach (two link rows per revision, one document, is normal).'
\echo '   anchor | documents'
WITH anchors AS (
  SELECT r.document_id,
         count(DISTINCT to_jsonb(r) ->> 'page_document_id') AS set_anchors,
         count(DISTINCT p.document_id) AS linked_pages
    FROM wiki_revisions r
    LEFT JOIN wiki_revisions_page_lnk l ON l.wiki_revision_id = r.id
    LEFT JOIN wiki_pages p ON p.id = l.wiki_page_id
   GROUP BY r.document_id
)
SELECT CASE
         WHEN set_anchors = 1 OR (set_anchors = 0 AND linked_pages = 1) THEN 'one'
         WHEN set_anchors = 0 AND linked_pages = 0 THEN 'none (orphan)'
         ELSE 'several (CONFLICT)'
       END AS anchor,
       count(*) AS documents
  FROM anchors GROUP BY 1 ORDER BY 1;

\echo '== R2 conflicts (must be 0): revision documents anchored to more than one page document'
\echo '   revision document_id | page document_ids'
WITH anchors AS (
  SELECT r.document_id,
         string_agg(DISTINCT to_jsonb(r) ->> 'page_document_id', ',') AS set_anchors,
         count(DISTINCT to_jsonb(r) ->> 'page_document_id') AS n_set,
         string_agg(DISTINCT p.document_id, ',' ORDER BY p.document_id) AS linked,
         count(DISTINCT p.document_id) AS n_linked
    FROM wiki_revisions r
    LEFT JOIN wiki_revisions_page_lnk l ON l.wiki_revision_id = r.id
    LEFT JOIN wiki_pages p ON p.id = l.wiki_page_id
   GROUP BY r.document_id
)
SELECT document_id, CASE WHEN n_set > 0 THEN set_anchors ELSE linked END AS pages
  FROM anchors
 WHERE n_set > 1 OR (n_set = 0 AND n_linked > 1)
 ORDER BY 1;

\echo '== R3 revisions per page (revision documents; save this list: the verification after the deploy compares with it)'
\echo '   page document_id | page title | revisions'
WITH anchored AS (
  SELECT r.document_id,
         coalesce(max(to_jsonb(r) ->> 'page_document_id'),
                  CASE WHEN count(DISTINCT p.document_id) = 1 THEN max(p.document_id) END) AS page
    FROM wiki_revisions r
    LEFT JOIN wiki_revisions_page_lnk l ON l.wiki_revision_id = r.id
    LEFT JOIN wiki_pages p ON p.id = l.wiki_page_id
   GROUP BY r.document_id
)
SELECT coalesce(a.page, '(no anchor)') AS page,
       coalesce((SELECT w.title FROM wiki_pages w WHERE w.document_id = a.page
                  ORDER BY w.published_at IS NULL, w.id LIMIT 1), '') AS title,
       count(*) AS revisions
  FROM anchored a GROUP BY a.page ORDER BY 1;

\echo '== R4 anomalies (must be 0 lines): two published or two draft rows of one revision document,'
\echo '   a row without document_id, a locale (wiki-revision is not localized)'
\echo '   problem | document_id | rows'
SELECT 'more than one published row' AS problem, document_id, count(*) AS rows
  FROM wiki_revisions WHERE published_at IS NOT NULL GROUP BY document_id HAVING count(*) > 1
UNION ALL
SELECT 'more than one draft row', document_id, count(*)
  FROM wiki_revisions WHERE published_at IS NULL GROUP BY document_id HAVING count(*) > 1
UNION ALL
SELECT 'no document_id', NULL, count(*) FROM wiki_revisions WHERE document_id IS NULL HAVING count(*) > 0
UNION ALL
SELECT 'a locale', document_id, count(*) FROM wiki_revisions WHERE locale IS NOT NULL GROUP BY document_id
ORDER BY 1, 2;

\else
\echo '== no wiki_revisions table: nothing to migrate (FAST PATH)'
\endif

ROLLBACK;
