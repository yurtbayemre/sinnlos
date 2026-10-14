#!/usr/bin/env bash
# Read-only census runner for the sinnlos PROD host (compose project 'infra').
# Prints NO secret values: SMTP_* are reported only as set/empty.
# Another compose project (a staging copy): COMPOSE_PROJECT=<project>, as for
# infra/deploy.sh; the containers are then <project>-db-1 and <project>-cms-1.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT="${COMPOSE_PROJECT:-infra}"
if ! [[ "${PROJECT}" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "ERROR: COMPOSE_PROJECT must be a compose project name (lower case, digits, - and _): ${PROJECT}" >&2
  exit 2
fi
DB="${PROJECT}-db-1"
CMS="${PROJECT}-cms-1"

echo "### DB census"
docker exec -i "${DB}" sh -c 'psql -X -v ON_ERROR_STOP=0 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "${DIR}/census.sql"

echo "### SMTP / digest env inside the running cms container (presence only)"
for v in SMTP_HOST SMTP_USER SMTP_PASS; do
  docker exec "${CMS}" sh -c "[ -n \"\${$v:-}\" ] && echo '$v=set' || echo '$v=EMPTY'"
done
docker exec "${CMS}" sh -c 'echo "DIGESTS_DISABLED=${DIGESTS_DISABLED:-<unset>}"'

echo "### Log window (docker logs only cover the CURRENT container; deploy.sh recreates it)"
docker inspect -f "${CMS} started {{.State.StartedAt}}" "${CMS}"

echo "### [digest] lines (skipped = dark; run complete = live)"
docker logs "${CMS}" 2>&1 | grep -F '[digest]' | tail -n 20 || true
echo "### [notifications] failed lines"
docker logs "${CMS}" 2>&1 | grep -cF '[notifications] failed' || true
docker logs "${CMS}" 2>&1 | grep -F '[notifications] failed' | tail -n 20 || true
