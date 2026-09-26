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
-- Must be 0 before migrate.sql can succeed: P0 anomalies, P4, P7, P8, P9.
-- Read before the migration: P1 (promoted units), P2 (discarded and
-- ADOPTED draft edits), P10 (orphan media rows migrate.sql removes) and
-- P11 (empty org relations, which the migration cannot restore).

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

\echo '== P1 draft-only units: never published, or unpublished in the admin (unpublish deletes the live row)'
\echo '   The migration PROMOTES them: they go live. Delete unwanted ones in the admin afterwards.'
SELECT 'department' AS type, id, document_id, name FROM departments d
 WHERE published_at IS NULL AND NOT EXISTS (SELECT 1 FROM departments p WHERE p.document_id = d.document_id AND p.published_at IS NOT NULL)
UNION ALL
SELECT 'team', id, document_id, name FROM teams t
 WHERE published_at IS NULL AND NOT EXISTS (SELECT 1 FROM teams p WHERE p.document_id = t.document_id AND p.published_at IS NOT NULL)
ORDER BY 1, 2;

\echo '== P2 pending draft edits of published units, one row per field'
\echo '   discarded            the live value stays. Write the edit down and re-enter it after the migration.'
\echo '   ADOPTED (goes live)  the live row has no value there, so the draft value goes live.'
\echo '                        An adopted head or lead can edit the unit right after the deploy.'
\echo '   members              union: draft-only members go live (ADOPTED), members removed only'
\echo '                        in the draft stay members (kept).'
\set QUIET on
\pset null '(none)'
\set QUIET off
WITH dep AS (
  SELECT p.document_id, p.name AS unit, d.id AS did, p.id AS pid,
         d.name AS d_name, p.name AS p_name, d.slug AS d_slug, p.slug AS p_slug,
         d.description AS d_desc, p.description AS p_desc, d.color AS d_color, p.color AS p_color
    FROM departments d JOIN departments p ON p.document_id = d.document_id AND p.published_at IS NOT NULL
   WHERE d.published_at IS NULL
), team AS (
  SELECT p.document_id, p.name AS unit, d.id AS did, p.id AS pid,
         d.name AS d_name, p.name AS p_name, d.slug AS d_slug, p.slug AS p_slug,
         d.description AS d_desc, p.description AS p_desc
    FROM teams d JOIN teams p ON p.document_id = d.document_id AND p.published_at IS NOT NULL
   WHERE d.published_at IS NULL
), heads AS (
  SELECT l.department_id AS row_id, string_agg(coalesce(u.username, '#' || u.id), '/' ORDER BY u.id) AS who
    FROM departments_head_lnk l JOIN up_users u ON u.id = l.user_id GROUP BY l.department_id
), leads AS (
  SELECT l.team_id AS row_id, string_agg(coalesce(u.username, '#' || u.id), '/' ORDER BY u.id) AS who
    FROM teams_lead_lnk l JOIN up_users u ON u.id = l.user_id GROUP BY l.team_id
), team_dept AS (
  -- compared by department DOCUMENT (a draft team may point at the draft department twin)
  SELECT l.team_id AS row_id,
         string_agg(dd.document_id, '/' ORDER BY dd.document_id) AS doc_key,
         string_agg(coalesce(pd.name, dd.name), '/' ORDER BY dd.document_id) AS what
    FROM teams_department_lnk l JOIN departments dd ON dd.id = l.department_id
    LEFT JOIN departments pd ON pd.document_id = dd.document_id AND pd.published_at IS NOT NULL
   GROUP BY l.team_id
), media AS (
  SELECT f.related_type, f.related_id AS row_id, f.field,
         string_agg(coalesce(fl.name, '?') || ' #' || f.file_id, '/' ORDER BY f.file_id) AS what
    FROM files_related_mph f LEFT JOIN files fl ON fl.id = f.file_id
   WHERE f.related_type IN ('api::department.department', 'api::team.team')
   GROUP BY 1, 2, 3
)
SELECT * FROM (
  SELECT 'department' AS type, x.unit, f.field,
         CASE WHEN f.owned AND f.live_value IS NULL THEN 'ADOPTED (goes live)' ELSE 'discarded' END AS outcome,
         f.draft_value, f.live_value, x.document_id
    FROM dep x
    LEFT JOIN heads dh ON dh.row_id = x.did
    LEFT JOIN heads ph ON ph.row_id = x.pid
    LEFT JOIN media dm ON dm.related_type = 'api::department.department' AND dm.row_id = x.did AND dm.field = 'headerImage'
    LEFT JOIN media pm ON pm.related_type = 'api::department.department' AND pm.row_id = x.pid AND pm.field = 'headerImage'
   CROSS JOIN LATERAL (VALUES
     ('name',        x.d_name  IS DISTINCT FROM x.p_name,  false, x.d_name::text,     x.p_name::text),
     ('slug',        x.d_slug  IS DISTINCT FROM x.p_slug,  false, x.d_slug::text,     x.p_slug::text),
     ('description', x.d_desc  IS DISTINCT FROM x.p_desc,  false, left(x.d_desc, 40), left(x.p_desc, 40)),
     ('color',       x.d_color IS DISTINCT FROM x.p_color, false, x.d_color::text,    x.p_color::text),
     ('head',        dh.who    IS DISTINCT FROM ph.who,    true,  dh.who,             ph.who),
     ('headerImage', dm.what   IS DISTINCT FROM pm.what,   true,  dm.what,            pm.what)
   ) f(field, differs, owned, draft_value, live_value)
   WHERE f.differs
  UNION ALL
  SELECT 'team', x.unit, f.field,
         CASE WHEN f.owned AND f.live_value IS NULL THEN 'ADOPTED (goes live)' ELSE 'discarded' END,
         f.draft_value, f.live_value, x.document_id
    FROM team x
    LEFT JOIN leads dl ON dl.row_id = x.did
    LEFT JOIN leads pl ON pl.row_id = x.pid
    LEFT JOIN team_dept dd ON dd.row_id = x.did
    LEFT JOIN team_dept pd ON pd.row_id = x.pid
    LEFT JOIN media dm ON dm.related_type = 'api::team.team' AND dm.row_id = x.did AND dm.field = 'avatar'
    LEFT JOIN media pm ON pm.related_type = 'api::team.team' AND pm.row_id = x.pid AND pm.field = 'avatar'
   CROSS JOIN LATERAL (VALUES
     ('name',        x.d_name   IS DISTINCT FROM x.p_name,   false, x.d_name::text,     x.p_name::text),
     ('slug',        x.d_slug   IS DISTINCT FROM x.p_slug,   false, x.d_slug::text,     x.p_slug::text),
     ('description', x.d_desc   IS DISTINCT FROM x.p_desc,   false, left(x.d_desc, 40), left(x.p_desc, 40)),
     ('department',  dd.doc_key IS DISTINCT FROM pd.doc_key, true,  dd.what,            pd.what),
     ('lead',        dl.who     IS DISTINCT FROM pl.who,     true,  dl.who,             pl.who),
     ('avatar',      dm.what    IS DISTINCT FROM pm.what,    true,  dm.what,            pm.what)
   ) f(field, differs, owned, draft_value, live_value)
   WHERE f.differs
  UNION ALL
  SELECT 'team', x.unit, 'members',
         CASE WHEN m.on_draft THEN 'ADOPTED (goes live)' ELSE 'kept (removed only in the draft)' END,
         CASE WHEN m.on_draft THEN m.who END, CASE WHEN NOT m.on_draft THEN m.who END, x.document_id
    FROM team x
   CROSS JOIN LATERAL (
     SELECT s.on_draft, string_agg(s.who, '/' ORDER BY s.who) AS who FROM (
       SELECT bool_or(l.team_id = x.did) AS on_draft, coalesce(u.username, '#' || u.id) AS who
         FROM teams_members_lnk l JOIN up_users u ON u.id = l.user_id
        WHERE l.team_id IN (x.did, x.pid)
        GROUP BY u.id, u.username HAVING count(DISTINCT l.team_id) = 1) s
      GROUP BY s.on_draft) m
) p2 ORDER BY type, unit, field, outcome;
\set QUIET on
\pset null ''
\set QUIET off

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

\echo '== P9 rows migrate.sql refuses (must be 0 - investigate first, the migration aborts otherwise)'
\echo '   "no document_id or a locale": not a plain Strapi 5 row of a non-localized type (M0).'
\echo '   "more than one <relation>": the merged row would have two targets on a to-one relation (M9);'
\echo '   fix it in the admin so the live row has exactly one.'
WITH to_one AS (
  -- n = targets after the merge: the live row's own if it has any, else the draft's (adopted)
  SELECT 'department' AS type, d.document_id, 'head' AS rel,
         count(DISTINCT l.user_id) FILTER (WHERE d.published_at IS NOT NULL) AS live_n,
         count(DISTINCT l.user_id) FILTER (WHERE d.published_at IS NULL) AS draft_n
    FROM departments d JOIN departments_head_lnk l ON l.department_id = d.id GROUP BY d.document_id
  UNION ALL
  SELECT 'team', t.document_id, 'lead',
         count(DISTINCT l.user_id) FILTER (WHERE t.published_at IS NOT NULL),
         count(DISTINCT l.user_id) FILTER (WHERE t.published_at IS NULL)
    FROM teams t JOIN teams_lead_lnk l ON l.team_id = t.id GROUP BY t.document_id
  UNION ALL
  SELECT 'team', t.document_id, 'department',
         count(DISTINCT dd.document_id) FILTER (WHERE t.published_at IS NOT NULL),
         count(DISTINCT dd.document_id) FILTER (WHERE t.published_at IS NULL)
    FROM teams t JOIN teams_department_lnk l ON l.team_id = t.id JOIN departments dd ON dd.id = l.department_id
   GROUP BY t.document_id
)
SELECT 'no document_id or a locale' AS problem, 'department' AS type, id, name AS unit
  FROM departments WHERE document_id IS NULL OR locale IS NOT NULL
UNION ALL
SELECT 'no document_id or a locale', 'team', id, name FROM teams WHERE document_id IS NULL OR locale IS NOT NULL
UNION ALL
SELECT 'more than one ' || o.rel, o.type, NULL,
       CASE o.type WHEN 'department'
         THEN (SELECT name FROM departments x WHERE x.document_id = o.document_id ORDER BY x.published_at IS NULL, x.id LIMIT 1)
         ELSE (SELECT name FROM teams x WHERE x.document_id = o.document_id ORDER BY x.published_at IS NULL, x.id LIMIT 1) END
  FROM to_one o
 WHERE CASE WHEN o.live_n > 0 THEN o.live_n ELSE o.draft_n END > 1
ORDER BY 1, 2, 4;

\echo '== P10 media rows (files_related_mph) that point at a department/team row that does not exist'
\echo '   migrate.sql DELETES them. They link nothing; the file itself stays in the media library.'
SELECT f.related_type, f.related_id, f.field, f.file_id, fl.name AS file
  FROM files_related_mph f LEFT JOIN files fl ON fl.id = f.file_id
 WHERE (f.related_type = 'api::department.department' AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.id = f.related_id))
    OR (f.related_type = 'api::team.team'             AND NOT EXISTS (SELECT 1 FROM teams t       WHERE t.id = f.related_id))
 ORDER BY 1, 2, 3;

\echo '== P11 empty org relations, as they will be after the migration (informational; the migration cannot fill them)'
\echo '   On the old release, editing and publishing a unit that had no draft yet (every demo-seed unit before its'
\echo '   first publish) in the admin dropped its head or lead, its department, and the users and teams linked to it.'
\echo '   Compare with the demo org chart (apps/cms/src/seed-demo.ts) or an older backup, and re-link what is missing'
\echo '   in the admin AFTER the migration (a save is live then and keeps every link).'
WITH dep_doc AS (
  SELECT document_id, (array_agg(name ORDER BY published_at IS NULL, id))[1] AS unit FROM departments GROUP BY document_id
), team_doc AS (
  SELECT document_id, (array_agg(name ORDER BY published_at IS NULL, id))[1] AS unit FROM teams GROUP BY document_id
), team_dept AS (
  -- team document -> the department document it will belong to (the live row's value wins, else the draft's)
  SELECT t.document_id,
         coalesce(min(dd.document_id) FILTER (WHERE t.published_at IS NOT NULL),
                  min(dd.document_id) FILTER (WHERE t.published_at IS NULL)) AS dept_doc
    FROM teams t JOIN teams_department_lnk l ON l.team_id = t.id JOIN departments dd ON dd.id = l.department_id
   GROUP BY t.document_id
)
SELECT * FROM (
  SELECT 'user' AS type, coalesce(u.username, '#' || u.id) AS name,
         'no department' || CASE WHEN u.blocked THEN ' (blocked user)' ELSE '' END AS empty
    FROM up_users u
   WHERE NOT EXISTS (SELECT 1 FROM up_users_department_lnk l WHERE l.user_id = u.id)
  UNION ALL
  SELECT 'department', x.unit, concat_ws(', ',
           CASE WHEN NOT EXISTS (SELECT 1 FROM departments_head_lnk l JOIN departments d ON d.id = l.department_id
                                  WHERE d.document_id = x.document_id) THEN 'no head' END,
           CASE WHEN NOT EXISTS (SELECT 1 FROM up_users_department_lnk l JOIN departments d ON d.id = l.department_id
                                  WHERE d.document_id = x.document_id) THEN 'no users' END,
           CASE WHEN NOT EXISTS (SELECT 1 FROM team_dept td WHERE td.dept_doc = x.document_id) THEN 'no teams' END)
    FROM dep_doc x
  UNION ALL
  SELECT 'team', x.unit, concat_ws(', ',
           CASE WHEN NOT EXISTS (SELECT 1 FROM team_dept td WHERE td.document_id = x.document_id) THEN 'no department' END,
           CASE WHEN NOT EXISTS (SELECT 1 FROM teams_lead_lnk l JOIN teams t ON t.id = l.team_id
                                  WHERE t.document_id = x.document_id) THEN 'no lead' END)
    FROM team_doc x
) p11 WHERE empty <> '' ORDER BY type, name;

ROLLBACK;
