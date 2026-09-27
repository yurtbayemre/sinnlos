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
-- Run it BEFORE the retag, with the cms STOPPED: every start of the new
-- cms grants the row again (a cms that failed its first boot restarts on
-- its own). From the checkout (e.g. /opt/sinnlos):
--   docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml stop cms
--   docker compose -p infra -f infra/docker-compose.yml -f infra/docker-compose.traefik.yml \
--     exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < infra/rollback/revoke-guest-poll-vote.sql
-- then retag and start the previous images. Run it once more after that
-- start: both DELETEs must report 0 (a 1 means the row had come back).
-- Runbook: docs/DEPLOYMENT.md, "Upgrading to poll department targeting",
-- Rollback.
--
-- NOT for a rollback to a cms WITH poll guest access: guests would lose
-- the vote on the polls opened to them until that cms starts again.
-- One transaction; idempotent (a second run deletes nothing). The same as
-- unticking Roles -> Guest -> Poll-vote -> vote in the admin panel: the
-- guest role's link and the permission row go, the other roles' vote
-- permissions (their own rows) stay.

BEGIN;

DELETE FROM up_permissions_role_lnk l
 USING up_permissions p, up_roles r
 WHERE l.permission_id = p.id
   AND l.role_id = r.id
   AND r.type = 'guest'
   AND p.action = 'api::poll-vote.poll-vote.vote';

DELETE FROM up_permissions p
 WHERE p.action = 'api::poll-vote.poll-vote.vote'
   AND NOT EXISTS (SELECT 1 FROM up_permissions_role_lnk l WHERE l.permission_id = p.id);

SELECT count(*) AS guest_poll_vote_grants_left
  FROM up_permissions p
  JOIN up_permissions_role_lnk l ON l.permission_id = p.id
  JOIN up_roles r ON r.id = l.role_id
 WHERE r.type = 'guest'
   AND p.action = 'api::poll-vote.poll-vote.vote';

COMMIT;
