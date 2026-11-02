-- Rollback from v0.35 to v0.34.0: deletes every secret share and every
-- secretShared notification (docs/UPGRADE.md, "Upgrading to v0.35.0",
-- rollback; docs/plan-v035-secret-sharing.md, section 5).
--
-- OWNER-RUN, and it CHANGES DATA: it deletes ALL rows of secret_shares, in
-- every state, and all notifications of type 'secretShared' (their actor
-- and recipient link rows go with them, ON DELETE CASCADE), in one
-- transaction. v0.34 has no janitor, so without this the shares' metadata
-- would stay forever, and its bell would show those notifications with its
-- fallback icon and a dead link. Run it after the retag to v0.34.0 (v0.34
-- writes nothing to the table); the rollback is complete only when it ran
-- successfully. The empty table and the inert permission rows stay.
--
--   docker exec -i infra-db-1 sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
--     < infra/diagnostics/secret-shares-rollback.sql
--
-- It works in the cms's schema only: public, or the setting sinnlos.schema
-- when the cms runs with another DATABASE_SCHEMA (add
-- -e PGOPTIONS='-c sinnlos.schema=<DATABASE_SCHEMA>' after `docker exec -i`;
-- a space in the name is written as "\ "). Tables of the same names in other
-- schemas are never touched. It prints the schema and how many rows went.
-- Where that schema has no secret_shares table (it never ran v0.35, or
-- another schema was meant) it stops with 'relation "secret_shares" does
-- not exist' and changes nothing.
-- Deleted rows come back only from a backup. v0.34's infra/restore-db.sh
-- does not close restored shares: after a restore on v0.34 of a backup taken
-- under v0.35, run this file again before the site opens.
--
-- Pure SQL, no psql meta-commands.
BEGIN;
SET LOCAL statement_timeout = '30s';
SELECT set_config('search_path',
                  quote_ident(coalesce(nullif(current_setting('sinnlos.schema', true), ''), 'public')),
                  true) AS schema;

WITH shares AS (
  DELETE FROM secret_shares RETURNING id
), notes AS (
  DELETE FROM notifications WHERE type = 'secretShared' RETURNING id
)
SELECT (SELECT count(*) FROM shares) AS secret_shares_deleted,
       (SELECT count(*) FROM notes) AS notifications_deleted;

COMMIT;
