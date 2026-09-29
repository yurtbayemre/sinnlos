-- One-time cleanup of the comment notifications that infra/live-smoke.sh
-- runs before batch 10 (IN06) left behind: every deploy posted "[live-smoke]"
-- comments as the smoke author on the newest announcement, and each one
-- notified that announcement's author. live-smoke deleted the comments but
-- not the notifications (census 2026-09-25: 33 rows). From batch 10 on,
-- live-smoke removes the notifications it causes itself.
--
-- OWNER-RUN, and it CHANGES DATA when armed. Without the guard it is a dry
-- run: it prints what would go and removes nothing.
--
-- What counts as residue: notifications of type 'comment' with the link
-- '/announcements' and a "<name> commented on "<title>"" title whose ACTOR is
-- the smoke author (default sam.chen@sinnlos.local, the demo account
-- live-smoke posts as). A real comment of that account would match too:
-- read the dry run's rows first.
--
-- 1. Dry run (removes nothing; note residue_rows):
--      docker exec -i infra-db-1 sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--        < infra/diagnostics/cleanup-live-smoke-notifications.sql
-- 2. Delete, armed with exactly that count (anything else removes nothing):
--      docker exec -i -e PGOPTIONS='-c sinnlos.cleanup_expected_rows=33' infra-db-1 \
--        sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--        < infra/diagnostics/cleanup-live-smoke-notifications.sql
--    Another smoke author: add -c sinnlos.cleanup_smoke_author=<e-mail> to PGOPTIONS.
-- The delete is one transaction and removes the notifications' actor and
-- recipient links with them. Deleted notifications cannot be restored
-- except from a backup (the nightly one or a pre-deploy one).
--
-- Pure SQL, no psql meta-commands: apps/cms/src/utils/
-- cleanup-live-smoke-notifications.pg.test.ts runs this file against
-- Postgres 16 as it is.
BEGIN;
SET LOCAL statement_timeout = '30s';

CREATE TEMP TABLE live_smoke_residue ON COMMIT DROP AS
SELECT n.id, n.created_at, n.title
  FROM notifications n
  JOIN notifications_actor_lnk a ON a.notification_id = n.id
  JOIN up_users u ON u.id = a.user_id
 WHERE lower(u.email) = lower(coalesce(nullif(current_setting('sinnlos.cleanup_smoke_author', true), ''),
                                       'sam.chen@sinnlos.local'))
   AND n.type = 'comment'
   AND n.link = '/announcements'
   AND n.title LIKE '% commented on "%';

-- What a delete would remove: the count, the time range, per title.
SELECT count(*) AS residue_rows, min(created_at) AS oldest, max(created_at) AS newest
  FROM live_smoke_residue;
SELECT title, count(*) AS rows
  FROM live_smoke_residue
 GROUP BY title
 ORDER BY count(*) DESC, title;

-- The guard: only with sinnlos.cleanup_expected_rows equal to residue_rows.
WITH expected AS (
  SELECT nullif(current_setting('sinnlos.cleanup_expected_rows', true), '') AS value
), doomed AS (
  SELECT id FROM live_smoke_residue
   WHERE (SELECT value FROM expected) = (SELECT count(*)::text FROM live_smoke_residue)
), actor_links AS (
  DELETE FROM notifications_actor_lnk l USING doomed d WHERE l.notification_id = d.id RETURNING l.id
), recipient_links AS (
  DELETE FROM notifications_recipient_lnk l USING doomed d WHERE l.notification_id = d.id RETURNING l.id
), removed AS (
  DELETE FROM notifications n USING doomed d WHERE n.id = d.id RETURNING n.id
)
SELECT (SELECT value FROM expected) AS expected_rows,
       (SELECT count(*) FROM live_smoke_residue) AS residue_rows,
       (SELECT count(*) FROM removed) AS notifications_removed,
       (SELECT count(*) FROM actor_links) + (SELECT count(*) FROM recipient_links) AS link_rows_removed,
       CASE
         WHEN (SELECT value FROM expected) IS NULL
           THEN 'dry run: nothing removed (arm it with sinnlos.cleanup_expected_rows = residue_rows)'
         WHEN (SELECT value FROM expected) <> (SELECT count(*)::text FROM live_smoke_residue)
           THEN 'expected_rows is not residue_rows: nothing removed'
         ELSE 'removed'
       END AS result;

COMMIT;
