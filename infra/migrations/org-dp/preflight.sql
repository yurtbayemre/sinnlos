-- org-dp PREFLIGHT (Postgres only; READ ONLY, changes nothing).
--
-- Shows what infra/migrations/org-dp/migrate.sql would do to department and
-- team before draftAndPublish is switched off for both. Runbook:
-- docs/DEPLOYMENT.md "One-time: org draft/publish off", notes in
-- infra/migrations/org-dp/README.md. Safe while the current release is
-- live:
--   docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
--     exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < infra/migrations/org-dp/preflight.sql
-- Non-default DATABASE_SCHEMA: add  -v schema=<name>  to the psql call.
--
-- FAST PATH: P0 draft_rows = 0 for departments AND teams means there is
-- nothing to migrate; deploy normally (infra/deploy.sh).
-- Must be 0 before migrate.sql can succeed: P0 anomalies, P4, P7, P8.

\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
\if :{?schema}
SET LOCAL search_path TO :"schema";
\endif

\echo '== P0 twin census (FAST PATH when draft_rows = 0 in both rows; anomalies must be 0)'
SELECT 'departments' AS type, count(DISTINCT document_id) AS documents,
       count(*) FILTER (WHERE published_at IS NULL) AS draft_rows,
       count(*) FILTER (WHERE published_at IS NOT NULL) AS published_rows,
       (SELECT count(*) FROM (SELECT document_id FROM departments GROUP BY document_id
          HAVING count(*) FILTER (WHERE published_at IS NULL) > 1 OR count(*) FILTER (WHERE published_at IS NOT NULL) > 1) x) AS anomalies
  FROM departments
UNION ALL
SELECT 'teams', count(DISTINCT document_id), count(*) FILTER (WHERE published_at IS NULL),
       count(*) FILTER (WHERE published_at IS NOT NULL),
       (SELECT count(*) FROM (SELECT document_id FROM teams GROUP BY document_id
          HAVING count(*) FILTER (WHERE published_at IS NULL) > 1 OR count(*) FILTER (WHERE published_at IS NOT NULL) > 1) x)
  FROM teams;

\echo '== P1 never-published documents (the migration PROMOTES them: they go live; delete unwanted ones in the admin afterwards)'
SELECT 'department' AS type, id, document_id, name FROM departments d
 WHERE published_at IS NULL AND NOT EXISTS (SELECT 1 FROM departments p WHERE p.document_id = d.document_id AND p.published_at IS NOT NULL)
UNION ALL
SELECT 'team', id, document_id, name FROM teams t
 WHERE published_at IS NULL AND NOT EXISTS (SELECT 1 FROM teams p WHERE p.document_id = t.document_id AND p.published_at IS NOT NULL)
ORDER BY 1, 2;

\echo '== P2 unpublished draft edits that will be DISCARDED (published values win) - write them down and re-enter them after the migration'
SELECT * FROM (
SELECT 'department' AS type, p.document_id, p.name,
       concat_ws(', ',
         CASE WHEN d.name        IS DISTINCT FROM p.name        THEN 'name: ' || coalesce(d.name, '')       END,
         CASE WHEN d.slug        IS DISTINCT FROM p.slug        THEN 'slug: ' || coalesce(d.slug, '')       END,
         CASE WHEN d.description IS DISTINCT FROM p.description THEN 'description changed'                  END,
         CASE WHEN d.color       IS DISTINCT FROM p.color       THEN 'color: ' || coalesce(d.color, '')     END,
         CASE WHEN (SELECT array_agg(user_id ORDER BY user_id) FROM departments_head_lnk WHERE department_id = d.id)
                   IS DISTINCT FROM (SELECT array_agg(user_id ORDER BY user_id) FROM departments_head_lnk WHERE department_id = p.id)
              THEN 'head: draft=' || coalesce((SELECT string_agg(user_id::text, '/') FROM departments_head_lnk WHERE department_id = d.id), 'none')
                   || ' live=' || coalesce((SELECT string_agg(user_id::text, '/') FROM departments_head_lnk WHERE department_id = p.id), 'none') END,
         CASE WHEN (SELECT array_agg(file_id ORDER BY file_id) FROM files_related_mph WHERE related_type = 'api::department.department' AND related_id = d.id)
                   IS DISTINCT FROM (SELECT array_agg(file_id ORDER BY file_id) FROM files_related_mph WHERE related_type = 'api::department.department' AND related_id = p.id)
              THEN 'headerImage changed' END) AS pending_changes
  FROM departments d JOIN departments p ON p.document_id = d.document_id AND p.published_at IS NOT NULL
 WHERE d.published_at IS NULL
UNION ALL
SELECT 'team', p.document_id, p.name,
       concat_ws(', ',
         CASE WHEN d.name        IS DISTINCT FROM p.name        THEN 'name: ' || coalesce(d.name, '')       END,
         CASE WHEN d.slug        IS DISTINCT FROM p.slug        THEN 'slug: ' || coalesce(d.slug, '')       END,
         CASE WHEN d.description IS DISTINCT FROM p.description THEN 'description changed'                  END,
         CASE WHEN (SELECT array_agg(user_id ORDER BY user_id) FROM teams_lead_lnk WHERE team_id = d.id)
                   IS DISTINCT FROM (SELECT array_agg(user_id ORDER BY user_id) FROM teams_lead_lnk WHERE team_id = p.id)
              THEN 'lead: draft=' || coalesce((SELECT string_agg(user_id::text, '/') FROM teams_lead_lnk WHERE team_id = d.id), 'none')
                   || ' live=' || coalesce((SELECT string_agg(user_id::text, '/') FROM teams_lead_lnk WHERE team_id = p.id), 'none') END,
         CASE WHEN (SELECT array_agg(x.document_id ORDER BY x.document_id) FROM teams_department_lnk l JOIN departments x ON x.id = l.department_id WHERE l.team_id = d.id)
                   IS DISTINCT FROM (SELECT array_agg(x.document_id ORDER BY x.document_id) FROM teams_department_lnk l JOIN departments x ON x.id = l.department_id WHERE l.team_id = p.id)
              THEN 'department changed' END,
         CASE WHEN (SELECT array_agg(user_id ORDER BY user_id) FROM teams_members_lnk WHERE team_id = d.id)
                   IS DISTINCT FROM (SELECT array_agg(user_id ORDER BY user_id) FROM teams_members_lnk WHERE team_id = p.id)
              THEN 'members differ (UNION is kept: draft-only additions go live, draft-only removals are not applied)' END,
         CASE WHEN (SELECT array_agg(file_id ORDER BY file_id) FROM files_related_mph WHERE related_type = 'api::team.team' AND related_id = d.id)
                   IS DISTINCT FROM (SELECT array_agg(file_id ORDER BY file_id) FROM files_related_mph WHERE related_type = 'api::team.team' AND related_id = p.id)
              THEN 'avatar changed' END)
  FROM teams d JOIN teams p ON p.document_id = d.document_id AND p.published_at IS NOT NULL
 WHERE d.published_at IS NULL
) p2 WHERE pending_changes <> '' ORDER BY 1, 3;

\echo '== P3 link rows by target row state (draft_links get re-pointed to the published row; after the migration all must be 0)'
SELECT tbl, count(*) FILTER (WHERE draft) AS draft_links, count(*) FILTER (WHERE NOT draft) AS published_links FROM (
  SELECT 'up_users_department_lnk' tbl, d.published_at IS NULL draft FROM up_users_department_lnk l JOIN departments d ON d.id = l.department_id
  UNION ALL SELECT 'announcements_department_lnk', d.published_at IS NULL FROM announcements_department_lnk l JOIN departments d ON d.id = l.department_id
  UNION ALL SELECT 'documents_departments_lnk',    d.published_at IS NULL FROM documents_departments_lnk l    JOIN departments d ON d.id = l.department_id
  UNION ALL SELECT 'events_departments_lnk',       d.published_at IS NULL FROM events_departments_lnk l       JOIN departments d ON d.id = l.department_id
  UNION ALL SELECT 'polls_departments_lnk',        d.published_at IS NULL FROM polls_departments_lnk l        JOIN departments d ON d.id = l.department_id
  UNION ALL SELECT 'quick_links_departments_lnk',  d.published_at IS NULL FROM quick_links_departments_lnk l  JOIN departments d ON d.id = l.department_id
  UNION ALL SELECT 'wiki_pages_department_lnk',    d.published_at IS NULL FROM wiki_pages_department_lnk l    JOIN departments d ON d.id = l.department_id
  UNION ALL SELECT 'wiki_spaces_department_lnk',   d.published_at IS NULL FROM wiki_spaces_department_lnk l   JOIN departments d ON d.id = l.department_id
  UNION ALL SELECT 'teams_department_lnk',         d.published_at IS NULL FROM teams_department_lnk l         JOIN departments d ON d.id = l.department_id
  UNION ALL SELECT 'departments_head_lnk',         d.published_at IS NULL FROM departments_head_lnk l         JOIN departments d ON d.id = l.department_id
  UNION ALL SELECT 'announcements_team_lnk',       t.published_at IS NULL FROM announcements_team_lnk l       JOIN teams t ON t.id = l.team_id
  UNION ALL SELECT 'wiki_pages_team_lnk',          t.published_at IS NULL FROM wiki_pages_team_lnk l          JOIN teams t ON t.id = l.team_id
  UNION ALL SELECT 'wiki_spaces_team_lnk',         t.published_at IS NULL FROM wiki_spaces_team_lnk l         JOIN teams t ON t.id = l.team_id
  UNION ALL SELECT 'teams_members_lnk',            t.published_at IS NULL FROM teams_members_lnk l            JOIN teams t ON t.id = l.team_id
  UNION ALL SELECT 'teams_lead_lnk',               t.published_at IS NULL FROM teams_lead_lnk l               JOIN teams t ON t.id = l.team_id
  UNION ALL SELECT 'files_related_mph (department)', d.published_at IS NULL FROM files_related_mph f JOIN departments d ON d.id = f.related_id WHERE f.related_type = 'api::department.department'
  UNION ALL SELECT 'files_related_mph (team)',       t.published_at IS NULL FROM files_related_mph f JOIN teams t ON t.id = f.related_id WHERE f.related_type = 'api::team.team'
) s GROUP BY tbl ORDER BY tbl;

\echo '== P4 users linked to MORE THAN ONE department document (must be 0 - fix in the admin first, the migration aborts otherwise)'
SELECT l.user_id, string_agg(DISTINCT d.name, ' | ') AS departments
  FROM up_users_department_lnk l JOIN departments d ON d.id = l.department_id
 GROUP BY l.user_id HAVING count(DISTINCT d.document_id) > 1
 ORDER BY 1;

\echo '== P5 users whose department link includes a DRAFT row (the ones the scoping bug hides department content from)'
SELECT u.id, u.username, d.name AS department,
       bool_or(d.published_at IS NULL) AS has_draft_link, bool_or(d.published_at IS NOT NULL) AS has_published_link
  FROM up_users u JOIN up_users_department_lnk l ON l.user_id = u.id JOIN departments d ON d.id = l.department_id
 GROUP BY u.id, u.username, d.name
HAVING bool_or(d.published_at IS NULL)
 ORDER BY u.id;

\echo '== P6 media rows on draft rows (kept only where the published row has none for that field)'
SELECT related_type, field, count(*) FROM files_related_mph f
 WHERE (related_type = 'api::department.department' AND related_id IN (SELECT id FROM departments WHERE published_at IS NULL))
    OR (related_type = 'api::team.team'             AND related_id IN (SELECT id FROM teams       WHERE published_at IS NULL))
 GROUP BY 1, 2 ORDER BY 1, 2;

\echo '== P7 duplicate department name/slug or team slug among the rows that will survive (must be 0 - rename first)'
WITH surv_d AS (SELECT * FROM departments d WHERE published_at IS NOT NULL
                   OR NOT EXISTS (SELECT 1 FROM departments p WHERE p.document_id = d.document_id AND p.published_at IS NOT NULL)),
     surv_t AS (SELECT * FROM teams t WHERE published_at IS NOT NULL
                   OR NOT EXISTS (SELECT 1 FROM teams p WHERE p.document_id = t.document_id AND p.published_at IS NOT NULL))
SELECT 'department name' AS what, name AS value, count(*) FROM surv_d GROUP BY name HAVING count(*) > 1
UNION ALL SELECT 'department slug', slug, count(*) FROM surv_d GROUP BY slug HAVING count(*) > 1
UNION ALL SELECT 'team slug', slug, count(*) FROM surv_t GROUP BY slug HAVING count(*) > 1;

\echo '== P8 tables with a foreign key into departments/teams that migrate.sql does not handle (must be 0)'
SELECT DISTINCT c.conrelid::regclass::text AS unhandled_table
  FROM pg_constraint c
 WHERE c.contype = 'f'
   AND c.confrelid IN ('departments'::regclass, 'teams'::regclass)
   AND c.conrelid::regclass::text NOT IN (
     'up_users_department_lnk', 'teams_department_lnk', 'departments_head_lnk',
     'announcements_department_lnk', 'documents_departments_lnk', 'events_departments_lnk',
     'polls_departments_lnk', 'quick_links_departments_lnk', 'wiki_pages_department_lnk',
     'wiki_spaces_department_lnk', 'teams_members_lnk', 'teams_lead_lnk',
     'announcements_team_lnk', 'wiki_pages_team_lnk', 'wiki_spaces_team_lnk');

ROLLBACK;
