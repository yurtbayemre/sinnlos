#!/usr/bin/env bash
# Read-only census runner for the sinnlos PROD host (compose project 'infra').
# Prints NO secret values: SMTP_* are reported only as set/empty.
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "### DB census"
docker exec -i infra-db-1 sh -c 'psql -X -v ON_ERROR_STOP=0 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "${DIR}/census.sql"

echo "### SMTP / digest env inside the running cms container (presence only)"
for v in SMTP_HOST SMTP_USER SMTP_PASS; do
  docker exec infra-cms-1 sh -c "[ -n \"\${$v:-}\" ] && echo '$v=set' || echo '$v=EMPTY'"
done
docker exec infra-cms-1 sh -c 'echo "DIGESTS_DISABLED=${DIGESTS_DISABLED:-<unset>}"'

echo "### Log window (docker logs only cover the CURRENT container; deploy.sh recreates it)"
docker inspect -f 'infra-cms-1 started {{.State.StartedAt}}' infra-cms-1

echo "### [digest] lines (skipped = dark; run complete = live)"
docker logs infra-cms-1 2>&1 | grep -F '[digest]' | tail -n 20 || true
echo "### [notifications] failed lines"
docker logs infra-cms-1 2>&1 | grep -cF '[notifications] failed' || true
docker logs infra-cms-1 2>&1 | grep -F '[notifications] failed' | tail -n 20 || true
