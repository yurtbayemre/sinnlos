#!/usr/bin/env bash
#
# mfa-reset.sh: clears the second factor (TOTP) of ONE local account, the
# way out when its owner lost the authenticator and every recovery code, or
# after ENCRYPTION_KEY changed (v0.27; docs/INSTALL.md). It raises the
# account's token version too, so every session of it ends; the next
# sign-in enrolls again. For an admin locked out of /manage/users, where
# another admin would use "2FA zurücksetzen".
#
# On the Docker host, as the deploy user (Postgres compose stacks):
#   infra/mfa-reset.sh anna@example.com
#
# One transaction in the db container: exactly one account with that
# e-mail address (case-insensitive) or nothing changes. Prints the account
# it reset, after the commit. Environment: COMPOSE_PROJECT (infra;
# infra/deploy.env as for deploy.sh).
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -e "${SCRIPT_DIR}/deploy.env" || -L "${SCRIPT_DIR}/deploy.env" ]]; then
  # shellcheck disable=SC1091 # the library next to this script, checked on its own
  source "${SCRIPT_DIR}/deploy-env.sh"
  load_deploy_env "${SCRIPT_DIR}/deploy.env" "${SCRIPT_DIR}/.."
fi

if [[ $# -ne 1 || "$1" != *@* ]]; then
  echo "usage: infra/mfa-reset.sh <e-mail address of the account>" >&2
  exit 2
fi
EMAIL="$1"
DB="${COMPOSE_PROJECT:-infra}-db-1"

# The address goes in as a psql variable (:'email' quotes it), never into the SQL text.
docker exec -i "${DB}" sh -c 'psql -X -q -v ON_ERROR_STOP=1 -v email="$1" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' sh "${EMAIL}" <<'SQL'
BEGIN;
CREATE TEMP TABLE mfa_target ON COMMIT DROP AS
  SELECT id FROM up_users WHERE lower(email) = lower(:'email');
DO $$
BEGIN
  IF (SELECT count(*) FROM mfa_target) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one account with that e-mail address, found %',
      (SELECT count(*) FROM mfa_target);
  END IF;
END $$;
UPDATE up_users
   SET totp_secret = NULL,
       totp_enabled_at = NULL,
       totp_last_step = NULL,
       totp_recovery_codes = NULL,
       token_version = COALESCE(token_version, 0) + 1
 WHERE id = (SELECT id FROM mfa_target)
RETURNING id AS reset_id, username AS reset_username, token_version AS reset_tv \gset
COMMIT;
\echo mfa-reset: second factor cleared for user :reset_id (:reset_username), token version now :reset_tv
SQL
