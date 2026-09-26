-- org-dp MIGRATION (Postgres only; one-time, owner instance).
--
-- Collapses the draft/published twins of department and team into ONE row
-- per document, so the cms release with draftAndPublish OFF for both types
-- boots with nothing left for Strapi's disable hook to delete
-- (@strapi/core 5.55.1 dist/migrations/draft-publish.js:48-65:
-- DELETE ... WHERE published_at IS NULL at boot, no transaction; the link
-- rows of every deleted draft cascade away).
--
-- Runbook: docs/DEPLOYMENT.md "One-time: org draft/publish off", notes in
-- infra/migrations/org-dp/README.md. Run the read-only preflight.sql first.
-- Run with cms and web STOPPED, right after a verified pg_dump, as ONE
-- transaction (the script refuses anything else):
--   docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
--     exec -T db sh -c 'psql -v ON_ERROR_STOP=1 --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < infra/migrations/org-dp/migrate.sql
-- Success ends with:  NOTICE:  org-dp: OK - departments=N, teams=M
-- Any RAISE rolls the whole transaction back; fix what it names and rerun.
-- Idempotent: a second run finds no drafts and changes nothing.
-- Non-default DATABASE_SCHEMA: add  -v schema=<name>  to the psql call.
--
-- Resolution rules:
--   - never-published documents are PROMOTED (their draft row becomes the
--     live row: published_at = updated_at);
--   - scalars (name, slug, description, color) and the to-one relations
--     the org row owns (department.head, team.lead, team.department) and
--     its media (department.headerImage, team.avatar): the PUBLISHED row
--     wins; the draft value is adopted only where the published row has
--     none;
--   - team.members: UNION of both rows (nobody loses access they have
--     today; draft-only removals are not applied);
--   - every link INTO a department or team (users, teams, and both rows of
--     announcement, document, event, poll, quick-link, wiki-page and
--     wiki-space) is re-pointed from the draft row to the published row of
--     the same document_id (union);
--   - then the draft rows are deleted (FK ON DELETE CASCADE removes their
--     remaining link rows; their media rows are removed explicitly).
--
-- The tables below are every table that references a department or team
-- row in the Strapi 5.55.1 schema of this app (derived from the models:
-- 15 link tables with a FOREIGN KEY into departments/teams, plus the
-- polymorphic files_related_mph, which has none). M0 aborts if the
-- database has any other foreign key into departments or teams.

\set ON_ERROR_STOP on
\if :{?schema}
SET search_path TO :"schema";
\endif

-- ---------- guard: exactly ONE transaction (psql --single-transaction) ----------
-- Without it every statement would commit on its own, and a RAISE in M9
-- could no longer undo M2..M8. An ON COMMIT DROP temp table only survives
-- to the next statement inside one transaction.
CREATE TEMP TABLE org_dp_single_txn ON COMMIT DROP AS SELECT 1 AS ok;
DO $$ BEGIN
  IF to_regclass('pg_temp.org_dp_single_txn') IS NULL THEN
    RAISE EXCEPTION 'org-dp: not inside one transaction - run: psql -v ON_ERROR_STOP=1 --single-transaction ... < migrate.sql';
  END IF;
END $$;

SET LOCAL lock_timeout = '10s';

-- ---------- M0 guards (nothing has been changed yet) ----------
DO $$
DECLARE n int; unknown text;
BEGIN
  -- cms must be stopped: another client could write between the checks
  -- and the deletes, or keep serving the old twin ids.
  SELECT count(*) INTO n FROM pg_stat_activity
   WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend';
  IF n > 0 THEN
    RAISE EXCEPTION 'org-dp: % other session(s) are connected to this database - stop cms and web first', n;
  END IF;

  -- Every foreign key into departments/teams must be one this script re-points.
  SELECT string_agg(DISTINCT c.conrelid::regclass::text, ', ') INTO unknown
    FROM pg_constraint c
   WHERE c.contype = 'f'
     AND c.confrelid IN ('departments'::regclass, 'teams'::regclass)
     AND c.conrelid::regclass::text NOT IN (
       'up_users_department_lnk', 'teams_department_lnk', 'departments_head_lnk',
       'announcements_department_lnk', 'documents_departments_lnk', 'events_departments_lnk',
       'polls_departments_lnk', 'quick_links_departments_lnk', 'wiki_pages_department_lnk',
       'wiki_spaces_department_lnk', 'teams_members_lnk', 'teams_lead_lnk',
       'announcements_team_lnk', 'wiki_pages_team_lnk', 'wiki_spaces_team_lnk');
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION 'org-dp: unhandled table(s) referencing departments/teams: % - extend migrate.sql first', unknown;
  END IF;

  IF EXISTS (SELECT 1 FROM departments WHERE document_id IS NULL OR locale IS NOT NULL)
  OR EXISTS (SELECT 1 FROM teams WHERE document_id IS NULL OR locale IS NOT NULL) THEN
    RAISE EXCEPTION 'org-dp: rows without document_id or with a locale - this script assumes non-localized Strapi 5 rows';
  END IF;

  IF EXISTS (SELECT 1 FROM departments GROUP BY document_id
              HAVING count(*) FILTER (WHERE published_at IS NULL) > 1
                  OR count(*) FILTER (WHERE published_at IS NOT NULL) > 1)
  OR EXISTS (SELECT 1 FROM teams GROUP BY document_id
              HAVING count(*) FILTER (WHERE published_at IS NULL) > 1
                  OR count(*) FILTER (WHERE published_at IS NOT NULL) > 1) THEN
    RAISE EXCEPTION 'org-dp: more than one draft or published row per document (preflight P0 anomalies) - investigate first';
  END IF;
END $$;

-- ---------- M1 snapshots for the lossless assertions in M9 ----------
-- Inbound links as (relation, source row, target DOCUMENT) pairs. Sources
-- are users and rows of other types, which all keep their ids.
CREATE TEMP TABLE org_pairs_before ON COMMIT DROP AS
  SELECT 'user.department' rel, l.user_id src, d.document_id tgt FROM up_users_department_lnk l JOIN departments d ON d.id = l.department_id
  UNION SELECT 'announcement.department', l.announcement_id, d.document_id FROM announcements_department_lnk l JOIN departments d ON d.id = l.department_id
  UNION SELECT 'document.departments',    l.document_id,     d.document_id FROM documents_departments_lnk l    JOIN departments d ON d.id = l.department_id
  UNION SELECT 'event.departments',       l.event_id,        d.document_id FROM events_departments_lnk l       JOIN departments d ON d.id = l.department_id
  UNION SELECT 'poll.departments',        l.poll_id,         d.document_id FROM polls_departments_lnk l        JOIN departments d ON d.id = l.department_id
  UNION SELECT 'quick-link.departments',  l.quick_link_id,   d.document_id FROM quick_links_departments_lnk l  JOIN departments d ON d.id = l.department_id
  UNION SELECT 'wiki-page.department',    l.wiki_page_id,    d.document_id FROM wiki_pages_department_lnk l    JOIN departments d ON d.id = l.department_id
  UNION SELECT 'wiki-space.department',   l.wiki_space_id,   d.document_id FROM wiki_spaces_department_lnk l   JOIN departments d ON d.id = l.department_id
  UNION SELECT 'announcement.team',       l.announcement_id, t.document_id FROM announcements_team_lnk l       JOIN teams t ON t.id = l.team_id
  UNION SELECT 'wiki-page.team',          l.wiki_page_id,    t.document_id FROM wiki_pages_team_lnk l          JOIN teams t ON t.id = l.team_id
  UNION SELECT 'wiki-space.team',         l.wiki_space_id,   t.document_id FROM wiki_spaces_team_lnk l         JOIN teams t ON t.id = l.team_id;
-- Team membership over BOTH rows: every (team document, user) pair must survive (union rule).
CREATE TEMP TABLE org_members_before ON COMMIT DROP AS
  SELECT DISTINCT t.document_id team_doc, l.user_id FROM teams_members_lnk l JOIN teams t ON t.id = l.team_id;
-- Every org document must survive (drafts are merged, never dropped).
CREATE TEMP TABLE org_docs_before ON COMMIT DROP AS
  SELECT 'department' kind, document_id FROM departments
  UNION SELECT 'team', document_id FROM teams;

-- ---------- M2 promote never-published documents (their draft row becomes the live row) ----------
UPDATE departments d SET published_at = coalesce(d.updated_at, d.created_at, now())
 WHERE d.published_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM departments p WHERE p.document_id = d.document_id AND p.published_at IS NOT NULL);
UPDATE teams t SET published_at = coalesce(t.updated_at, t.created_at, now())
 WHERE t.published_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM teams p WHERE p.document_id = t.document_id AND p.published_at IS NOT NULL);

-- ---------- M3 draft id -> published id of the same document (only twins remain) ----------
CREATE TEMP TABLE dept_map ON COMMIT DROP AS
  SELECT d.id draft_id, p.id pub_id FROM departments d
    JOIN departments p ON p.document_id = d.document_id AND p.published_at IS NOT NULL
   WHERE d.published_at IS NULL;
CREATE TEMP TABLE team_map ON COMMIT DROP AS
  SELECT d.id draft_id, p.id pub_id FROM teams d
    JOIN teams p ON p.document_id = d.document_id AND p.published_at IS NOT NULL
   WHERE d.published_at IS NULL;

-- ---------- M4 what a department owns: head (to-one) + headerImage. Published wins. ----------
INSERT INTO departments_head_lnk (department_id, user_id)
  SELECT m.pub_id, l.user_id FROM departments_head_lnk l JOIN dept_map m ON m.draft_id = l.department_id
   WHERE NOT EXISTS (SELECT 1 FROM departments_head_lnk x WHERE x.department_id = m.pub_id)
  ON CONFLICT (department_id, user_id) DO NOTHING;
UPDATE files_related_mph f SET related_id = m.pub_id FROM dept_map m
 WHERE f.related_type = 'api::department.department' AND f.related_id = m.draft_id
   AND NOT EXISTS (SELECT 1 FROM files_related_mph x
                    WHERE x.related_type = 'api::department.department' AND x.field = f.field AND x.related_id = m.pub_id);
DELETE FROM files_related_mph f USING dept_map m
 WHERE f.related_type = 'api::department.department' AND f.related_id = m.draft_id;

-- ---------- M5 what a team owns: department + lead (to-one, published wins), members (union), avatar ----------
INSERT INTO teams_department_lnk (team_id, department_id, team_ord)
  SELECT m.pub_id, l.department_id, l.team_ord FROM teams_department_lnk l JOIN team_map m ON m.draft_id = l.team_id
   WHERE NOT EXISTS (SELECT 1 FROM teams_department_lnk x WHERE x.team_id = m.pub_id)
  ON CONFLICT (team_id, department_id) DO NOTHING;
INSERT INTO teams_lead_lnk (team_id, user_id)
  SELECT m.pub_id, l.user_id FROM teams_lead_lnk l JOIN team_map m ON m.draft_id = l.team_id
   WHERE NOT EXISTS (SELECT 1 FROM teams_lead_lnk x WHERE x.team_id = m.pub_id)
  ON CONFLICT (team_id, user_id) DO NOTHING;
INSERT INTO teams_members_lnk (team_id, user_id, user_ord, team_ord)
  SELECT m.pub_id, l.user_id, l.user_ord, l.team_ord FROM teams_members_lnk l JOIN team_map m ON m.draft_id = l.team_id
  ON CONFLICT (team_id, user_id) DO NOTHING;
UPDATE files_related_mph f SET related_id = m.pub_id FROM team_map m
 WHERE f.related_type = 'api::team.team' AND f.related_id = m.draft_id
   AND NOT EXISTS (SELECT 1 FROM files_related_mph x
                    WHERE x.related_type = 'api::team.team' AND x.field = f.field AND x.related_id = m.pub_id);
DELETE FROM files_related_mph f USING team_map m
 WHERE f.related_type = 'api::team.team' AND f.related_id = m.draft_id;

-- ---------- M6 every link INTO a department: draft id -> published id (union) ----------
INSERT INTO up_users_department_lnk (user_id, department_id, user_ord)
  SELECT l.user_id, m.pub_id, l.user_ord FROM up_users_department_lnk l JOIN dept_map m ON m.draft_id = l.department_id
  ON CONFLICT (user_id, department_id) DO NOTHING;
INSERT INTO teams_department_lnk (team_id, department_id, team_ord)
  SELECT l.team_id, m.pub_id, l.team_ord FROM teams_department_lnk l JOIN dept_map m ON m.draft_id = l.department_id
  ON CONFLICT (team_id, department_id) DO NOTHING;
INSERT INTO announcements_department_lnk (announcement_id, department_id)
  SELECT l.announcement_id, m.pub_id FROM announcements_department_lnk l JOIN dept_map m ON m.draft_id = l.department_id
  ON CONFLICT (announcement_id, department_id) DO NOTHING;
INSERT INTO documents_departments_lnk (document_id, department_id, department_ord)
  SELECT l.document_id, m.pub_id, l.department_ord FROM documents_departments_lnk l JOIN dept_map m ON m.draft_id = l.department_id
  ON CONFLICT (document_id, department_id) DO NOTHING;
INSERT INTO events_departments_lnk (event_id, department_id, department_ord)
  SELECT l.event_id, m.pub_id, l.department_ord FROM events_departments_lnk l JOIN dept_map m ON m.draft_id = l.department_id
  ON CONFLICT (event_id, department_id) DO NOTHING;
INSERT INTO polls_departments_lnk (poll_id, department_id, department_ord)
  SELECT l.poll_id, m.pub_id, l.department_ord FROM polls_departments_lnk l JOIN dept_map m ON m.draft_id = l.department_id
  ON CONFLICT (poll_id, department_id) DO NOTHING;
INSERT INTO quick_links_departments_lnk (quick_link_id, department_id, department_ord)
  SELECT l.quick_link_id, m.pub_id, l.department_ord FROM quick_links_departments_lnk l JOIN dept_map m ON m.draft_id = l.department_id
  ON CONFLICT (quick_link_id, department_id) DO NOTHING;
INSERT INTO wiki_pages_department_lnk (wiki_page_id, department_id, wiki_page_ord)
  SELECT l.wiki_page_id, m.pub_id, l.wiki_page_ord FROM wiki_pages_department_lnk l JOIN dept_map m ON m.draft_id = l.department_id
  ON CONFLICT (wiki_page_id, department_id) DO NOTHING;
INSERT INTO wiki_spaces_department_lnk (wiki_space_id, department_id)
  SELECT l.wiki_space_id, m.pub_id FROM wiki_spaces_department_lnk l JOIN dept_map m ON m.draft_id = l.department_id
  ON CONFLICT (wiki_space_id, department_id) DO NOTHING;

-- ---------- M7 every link INTO a team (team.members was merged in M5) ----------
INSERT INTO announcements_team_lnk (announcement_id, team_id)
  SELECT l.announcement_id, m.pub_id FROM announcements_team_lnk l JOIN team_map m ON m.draft_id = l.team_id
  ON CONFLICT (announcement_id, team_id) DO NOTHING;
INSERT INTO wiki_pages_team_lnk (wiki_page_id, team_id, wiki_page_ord)
  SELECT l.wiki_page_id, m.pub_id, l.wiki_page_ord FROM wiki_pages_team_lnk l JOIN team_map m ON m.draft_id = l.team_id
  ON CONFLICT (wiki_page_id, team_id) DO NOTHING;
INSERT INTO wiki_spaces_team_lnk (wiki_space_id, team_id)
  SELECT l.wiki_space_id, m.pub_id FROM wiki_spaces_team_lnk l JOIN team_map m ON m.draft_id = l.team_id
  ON CONFLICT (wiki_space_id, team_id) DO NOTHING;

-- ---------- M8 drop the draft rows (FK ON DELETE CASCADE removes their leftover link rows) ----------
DELETE FROM teams       WHERE id IN (SELECT draft_id FROM team_map);
DELETE FROM departments WHERE id IN (SELECT draft_id FROM dept_map);

-- ---------- M9 post-conditions: any failure rolls back the whole transaction ----------
DO $$
DECLARE n int;
BEGIN
  IF EXISTS (SELECT 1 FROM departments WHERE published_at IS NULL) OR EXISTS (SELECT 1 FROM teams WHERE published_at IS NULL) THEN
    RAISE EXCEPTION 'org-dp: draft rows left';
  END IF;
  IF (SELECT count(*) <> count(DISTINCT document_id) FROM departments)
  OR (SELECT count(*) <> count(DISTINCT document_id) FROM teams) THEN
    RAISE EXCEPTION 'org-dp: more than one row per document';
  END IF;
  SELECT count(*) INTO n FROM (
    SELECT kind, document_id FROM org_docs_before
    EXCEPT (SELECT 'department', document_id FROM departments UNION SELECT 'team', document_id FROM teams)) lost;
  IF n > 0 THEN RAISE EXCEPTION 'org-dp: % department/team document(s) would be lost', n; END IF;

  SELECT count(*) INTO n FROM (
    SELECT rel, src, tgt FROM org_pairs_before
    EXCEPT
    (SELECT 'user.department', l.user_id, d.document_id FROM up_users_department_lnk l JOIN departments d ON d.id = l.department_id
     UNION SELECT 'announcement.department', l.announcement_id, d.document_id FROM announcements_department_lnk l JOIN departments d ON d.id = l.department_id
     UNION SELECT 'document.departments',    l.document_id,     d.document_id FROM documents_departments_lnk l    JOIN departments d ON d.id = l.department_id
     UNION SELECT 'event.departments',       l.event_id,        d.document_id FROM events_departments_lnk l       JOIN departments d ON d.id = l.department_id
     UNION SELECT 'poll.departments',        l.poll_id,         d.document_id FROM polls_departments_lnk l        JOIN departments d ON d.id = l.department_id
     UNION SELECT 'quick-link.departments',  l.quick_link_id,   d.document_id FROM quick_links_departments_lnk l  JOIN departments d ON d.id = l.department_id
     UNION SELECT 'wiki-page.department',    l.wiki_page_id,    d.document_id FROM wiki_pages_department_lnk l    JOIN departments d ON d.id = l.department_id
     UNION SELECT 'wiki-space.department',   l.wiki_space_id,   d.document_id FROM wiki_spaces_department_lnk l   JOIN departments d ON d.id = l.department_id
     UNION SELECT 'announcement.team',       l.announcement_id, t.document_id FROM announcements_team_lnk l       JOIN teams t ON t.id = l.team_id
     UNION SELECT 'wiki-page.team',          l.wiki_page_id,    t.document_id FROM wiki_pages_team_lnk l          JOIN teams t ON t.id = l.team_id
     UNION SELECT 'wiki-space.team',         l.wiki_space_id,   t.document_id FROM wiki_spaces_team_lnk l         JOIN teams t ON t.id = l.team_id)) lost;
  IF n > 0 THEN RAISE EXCEPTION 'org-dp: % inbound link pair(s) would be lost', n; END IF;

  SELECT count(*) INTO n FROM (
    SELECT team_doc, user_id FROM org_members_before
    EXCEPT SELECT t.document_id, l.user_id FROM teams_members_lnk l JOIN teams t ON t.id = l.team_id) lost;
  IF n > 0 THEN RAISE EXCEPTION 'org-dp: % team membership(s) would be lost', n; END IF;

  IF EXISTS (SELECT 1 FROM up_users_department_lnk GROUP BY user_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'org-dp: a user would have more than one department (preflight P4)';
  END IF;
  IF EXISTS (SELECT 1 FROM departments_head_lnk GROUP BY department_id HAVING count(*) > 1)
  OR EXISTS (SELECT 1 FROM teams_lead_lnk GROUP BY team_id HAVING count(*) > 1)
  OR EXISTS (SELECT 1 FROM teams_department_lnk GROUP BY team_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'org-dp: a to-one relation (department.head, team.lead, team.department) would have more than one target';
  END IF;
  IF EXISTS (SELECT 1 FROM files_related_mph f WHERE f.related_type = 'api::department.department'
               AND NOT EXISTS (SELECT 1 FROM departments d WHERE d.id = f.related_id))
  OR EXISTS (SELECT 1 FROM files_related_mph f WHERE f.related_type = 'api::team.team'
               AND NOT EXISTS (SELECT 1 FROM teams t WHERE t.id = f.related_id)) THEN
    RAISE EXCEPTION 'org-dp: media rows (files_related_mph) point at a missing department/team';
  END IF;
  -- Strapi checks unique/uid attributes against every published row with an
  -- exact match (entity-validator validators.js), so a duplicate here would
  -- make both rows unsavable. Only promoted drafts can introduce one.
  IF EXISTS (SELECT 1 FROM departments GROUP BY name HAVING count(*) > 1)
  OR EXISTS (SELECT 1 FROM departments GROUP BY slug HAVING count(*) > 1)
  OR EXISTS (SELECT 1 FROM teams GROUP BY slug HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'org-dp: duplicate department name/slug or team slug across documents - rename one first (preflight P7)';
  END IF;

  RAISE NOTICE 'org-dp: OK - departments=%, teams=%', (SELECT count(*) FROM departments), (SELECT count(*) FROM teams);
END $$;
