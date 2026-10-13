-- Re-targeting list (READ-ONLY), valid from batch 15 on.
--
-- Lists the rows that batch 15 keeps restricted by a marker or a flag
-- alone, per row (draft and published apart):
--   1. announcements with retarget_required = true: a department or team
--      they targeted was deleted, so they are readable by admins and
--      editors only and notify nobody until a moderator re-targets them
--      ("Needs re-targeting" in /manage; decision 06 §N9, amendment row A3);
--   2. events restricted only by their flag: notify_audience = 'departments'
--      without a department link. They notify nobody on a publish until
--      re-targeted (they stay readable calendar-wide).
-- D-PT01 announcements (audience 'departments' without a department or
-- team) are listed by announcement-audience-preflight.sql.
--
-- WHEN. Before a rollback to a batch-14 image, save the output off the host
-- (DEPLOYMENT.md "Deploying batch 15", rollback step 2): the old image knows
-- neither the marker nor notify_audience, so (1) re-widens to its remaining
-- criteria and (2) notifies everyone on its next publish, and an old-image
-- publish or "Discard changes" rewrites rows without these columns (NULL).
-- On the roll-forward the boot backfill restores a lost value from the
-- surviving twin row; for documents where both rows lost it, re-apply it
-- from the saved list with guarded raise-only SQL:
--   UPDATE announcements SET retarget_required = true
--    WHERE document_id IN (<saved>) AND retarget_required IS NOT TRUE;
--   UPDATE events SET notify_audience = 'departments'
--    WHERE document_id IN (<saved>) AND notify_audience IS DISTINCT FROM 'departments';
-- (Not "IS NULL" for events: when neither twin restricts, the backfill
-- fills a NULL notify_audience without a department link with 'all' at the
-- first boot, before this runs.) Both only raise, so they need no revision
-- advance (decision 06 §G "Rule").
-- The columns do not exist before batch 15: on a batch-14 schema this file
-- fails with "column ... does not exist" and changes nothing.
--
--   docker exec -i infra-db-1 sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < infra/diagnostics/announcement-retarget.sql
--
-- Pure SQL, no psql meta-commands: the integration suite
-- targeting-fail-closed runs this file against Postgres 16 as it is.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

SELECT 'retarget summary' AS check,
       (SELECT count(DISTINCT document_id) FROM announcements WHERE retarget_required IS TRUE)
         AS marked_announcements,
       (SELECT count(DISTINCT document_id) FROM announcements
         WHERE retarget_required IS TRUE AND published_at IS NOT NULL)
         AS marked_published_announcements,
       (SELECT count(DISTINCT e.document_id) FROM events e
         WHERE e.notify_audience = 'departments'
           AND NOT EXISTS (SELECT 1 FROM events_departments_lnk l WHERE l.event_id = e.id))
         AS flag_only_events;

-- 1. The marked announcements, with what targeting is left on each row.
SELECT 'marked announcement' AS check,
       a.document_id,
       CASE WHEN a.published_at IS NULL THEN 'draft' ELSE 'published' END AS status,
       a.title,
       a.audience,
       EXISTS (SELECT 1 FROM announcements_department_lnk d WHERE d.announcement_id = a.id)
         AS links_department,
       EXISTS (SELECT 1 FROM announcements_team_lnk t WHERE t.announcement_id = a.id)
         AS links_team,
       a.published_at
  FROM announcements a
 WHERE a.retarget_required IS TRUE
 ORDER BY (a.published_at IS NULL), a.document_id, a.id;

-- 2. The events restricted only by their flag.
SELECT 'flag-only event' AS check,
       e.document_id,
       CASE WHEN e.published_at IS NULL THEN 'draft' ELSE 'published' END AS status,
       e.title,
       e.start,
       e.published_at
  FROM events e
 WHERE e.notify_audience = 'departments'
   AND NOT EXISTS (SELECT 1 FROM events_departments_lnk l WHERE l.event_id = e.id)
 ORDER BY (e.published_at IS NULL), e.document_id, e.id;

ROLLBACK;
