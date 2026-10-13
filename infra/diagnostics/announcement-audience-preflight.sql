-- D-PT01 preflight (READ-ONLY): the announcements batch 15 hides.
--
-- From batch 15 on, an announcement whose audience is 'departments' but
-- that links neither a department nor a team is readable by admins and
-- editors only and notifies nobody (decision 06 §B6, D-PT01). Before, such
-- a row was company-wide. This lists exactly those rows, so the owner can
-- re-target or accept each one before the deploy; the count goes into the
-- release note (DEPLOYMENT.md "Deploying batch 15").
--
-- Runs on the batch-14 schema (before the deploy) and on every later one;
-- it reads only columns batch 14 already has. Also part of the rollback
-- list: on a batch-14 image these rows are company-wide again.
--
--   docker exec -i infra-db-1 sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < infra/diagnostics/announcement-audience-preflight.sql
--
-- Output: one summary row, then one row per announcement row (draft and
-- published apart) with its document_id, title and published_at, and
-- `on_rollback` for the saved list of a rollback to batch 14
-- (DEPLOYMENT.md "Deploying batch 15", R2): `hide_then_restore` on a
-- published row (unpublish it for the window, R3; republish it after the
-- roll-forward, R6f), `none` on a draft row. Titles are content, not
-- personal data; treat the output as internal anyway.
--
-- Pure SQL, no psql meta-commands: the integration suite
-- targeting-fail-closed runs this file against Postgres 16 as it is.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

-- Summary: the documents D-PT01 hides, and those a member reads today
-- (a published row that matches).
SELECT 'd-pt01 summary' AS check,
       count(DISTINCT a.document_id) AS documents,
       count(DISTINCT a.document_id) FILTER (WHERE a.published_at IS NOT NULL) AS published_documents,
       count(*) AS rows
  FROM announcements a
 WHERE a.audience = 'departments'
   AND NOT EXISTS (SELECT 1 FROM announcements_department_lnk d WHERE d.announcement_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM announcements_team_lnk t WHERE t.announcement_id = a.id);

-- The rows, published first, then by document.
SELECT 'd-pt01 row' AS check,
       a.document_id,
       CASE WHEN a.published_at IS NULL THEN 'draft' ELSE 'published' END AS status,
       a.title,
       a.published_at,
       a.updated_at,
       CASE WHEN a.published_at IS NULL THEN 'none' ELSE 'hide_then_restore' END AS on_rollback
  FROM announcements a
 WHERE a.audience = 'departments'
   AND NOT EXISTS (SELECT 1 FROM announcements_department_lnk d WHERE d.announcement_id = a.id)
   AND NOT EXISTS (SELECT 1 FROM announcements_team_lnk t WHERE t.announcement_id = a.id)
 ORDER BY (a.published_at IS NULL), a.document_id, a.id;

ROLLBACK;
