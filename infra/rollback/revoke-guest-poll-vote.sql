-- Rollback from poll guest access to a cms from before it (Postgres only;
-- WRITES the users-permissions tables). On the owner instance: rolling
-- back the deploy of poll department targeting + guest access to 34c250c.
--
-- The first boot of the guest access release grants the guest role
-- api::poll-vote.poll-vote.vote (apps/cms/src/index.ts
-- CUSTOM_ACTION_GRANTS). A cms from before it ignores the per-poll guest
-- switches and the department targeting and never removes that row: while
-- it exists there, every guest can vote on every open published poll,
-- also on polls hidden from guests and on polls of other departments.
-- Users-permissions reads a role's permissions from the database on every
-- request, so the removal takes effect at once, no restart needed.
--
-- Every rollback to a cms from before guest access runs it twice, whatever
-- the database or the admin panel shows at the time: a new cms whose first
-- boot missed compose's health deadline or failed can still be starting or
-- restarting and grant the row afterwards.
-- From the checkout (e.g. /opt/sinnlos):
--   1. stop the cms:
--      docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml stop cms
--   2. run this file:
--      docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
--        exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--        < infra/rollback/revoke-guest-poll-vote.sql
--   3. retag and start the previous images (up -d --no-build web cms);
--   4. once the previous cms is up, run this file again: it must remove
--      nothing (guest_links_removed 0, permission_rows_removed 0).
-- Runbook: docs/DEPLOYMENT.md, "Upgrading to poll department targeting",
-- Rollback.
--
-- NOT for a rollback to a cms WITH poll guest access: that cms grants the
-- row itself on every start, and without it guests lose the vote on the
-- polls opened to them.
--
-- One statement in one transaction; idempotent (a second run removes
-- nothing). It deletes the guest role's links to the vote permission and
-- then, of the permission rows it unlinked, those that no role links any
-- more (users-permissions gives each role its own row, so that is the
-- guest's row). The other roles' vote permissions stay, and so does any
-- permission row this run did not unlink, an orphan from before included.
-- The data-modifying CTEs share one snapshot: the second one still sees
-- the links the first one deletes, hence "other than the ones unlinked".

BEGIN;

WITH unlinked AS (
  DELETE FROM up_permissions_role_lnk l
   USING up_permissions p, up_roles r
   WHERE l.permission_id = p.id
     AND l.role_id = r.id
     AND r.type = 'guest'
     AND p.action = 'api::poll-vote.poll-vote.vote'
  RETURNING l.id, l.permission_id
), removed AS (
  DELETE FROM up_permissions p
   WHERE p.id IN (SELECT permission_id FROM unlinked)
     AND NOT EXISTS (SELECT 1 FROM up_permissions_role_lnk l
                      WHERE l.permission_id = p.id
                        AND l.id NOT IN (SELECT id FROM unlinked))
  RETURNING p.id
)
SELECT (SELECT count(*) FROM unlinked) AS guest_links_removed,
       (SELECT count(*) FROM removed) AS permission_rows_removed;

SELECT count(*) AS guest_poll_vote_grants_left
  FROM up_permissions p
  JOIN up_permissions_role_lnk l ON l.permission_id = p.id
  JOIN up_roles r ON r.id = l.role_id
 WHERE r.type = 'guest'
   AND p.action = 'api::poll-vote.poll-vote.vote';

COMMIT;
