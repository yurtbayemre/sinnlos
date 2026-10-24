#!/usr/bin/env bash
#
# ops-check.sh: the host check behind the documented alerts (v0.29, S8;
# docs/OPERATIONS.md, Monitoring). Silent and exit 0 when everything is in
# order; otherwise one line per problem on stdout and exit 1, so a cron
# line with MAILTO mails exactly the problems:
#   0 * * * * /path/to/infra/ops-check.sh
# A line starting with UNKNOWN is a check that could not be made (a failed
# docker or psql call, an unreadable file, a malformed time); it counts as a
# problem: a check that cannot look must not report "clean".
#
#  1. Backup age: the newest complete nightly backup, from
#     $SINNLOS_BACKUP_DIR/offsite/sinnlos/last-success (pg-backup.sh) or,
#     with OPS_BACKUP_STATUS, backup-run's `backup-status` file
#     (daily_last_ok_at=), is at most OPS_BACKUP_MAX_AGE_HOURS (26) old.
#  2. Disk: at least OPS_DISK_MIN_PERCENT (15) free on the Docker root and
#     the database volume (seen from the db container), the uploads volume
#     (from the cms container), the backup directory and this checkout
#     (restore-db.sh keeps its safety dumps in infra/backups).
#  3. Cron: the status the cms keeps in its core store (apps/cms/src/cron/
#     cron-status.ts), read with psql in the db container: cron is on, every
#     expected task ran within its interval + max(15 min, a tenth of it)
#     (after a grace of that length once it became expected), none failed
#     on its last run, none failed within OPS_CRON_LOOKBACK_MINUTES (120).
#
# Clean, with OPS_PUSH_URL set (an Uptime Kuma push URL, for example), it
# calls that URL; a failed push is a problem too, so a host check that
# cannot reach its monitor still mails. Environment: COMPOSE_PROJECT (infra)
# and SINNLOS_BACKUP_DIR, also from infra/deploy.env as for deploy.sh.
set -Euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -e "${SCRIPT_DIR}/deploy.env" || -L "${SCRIPT_DIR}/deploy.env" ]]; then
  # shellcheck disable=SC1091 # the library next to this script, checked on its own
  source "${SCRIPT_DIR}/deploy-env.sh"
  load_deploy_env "${SCRIPT_DIR}/deploy.env" "${SCRIPT_DIR}/.."
fi

PROJECT="${COMPOSE_PROJECT:-infra}"
MAX_AGE_HOURS="${OPS_BACKUP_MAX_AGE_HOURS:-26}"
DISK_MIN="${OPS_DISK_MIN_PERCENT:-15}"
LOOKBACK="${OPS_CRON_LOOKBACK_MINUTES:-120}"
NOW="$(date -u +%s)"
problems=0

problem() {
  echo "$*"
  problems=$((problems + 1))
}

# An ISO time as epoch seconds, or nothing (and status 1) when it is not one.
epoch() {
  [[ -n "$1" ]] && date -u -d "$1" +%s 2>/dev/null
}

check_backup() {
  local file stamp ts
  if [[ -n "${OPS_BACKUP_STATUS:-}" ]]; then
    file="${OPS_BACKUP_STATUS}"
    stamp="$(sed -n 's/^daily_last_ok_at=//p' "${file}" 2>/dev/null | tail -n 1)"
  elif [[ -n "${SINNLOS_BACKUP_DIR:-}" ]]; then
    file="${SINNLOS_BACKUP_DIR}/offsite/sinnlos/last-success"
    stamp="$(awk 'NR == 1 { print $1 }' "${file}" 2>/dev/null)"
  else
    problem "UNKNOWN backup age: set SINNLOS_BACKUP_DIR (pg-backup.sh) or OPS_BACKUP_STATUS (backup-run)"
    return
  fi
  if [[ ! -r "${file}" ]]; then
    problem "UNKNOWN backup age: ${file} is missing or unreadable"
  elif ! ts="$(epoch "${stamp}")"; then
    problem "UNKNOWN backup age: no valid time in ${file}"
  elif ((NOW - ts > MAX_AGE_HOURS * 3600)); then
    problem "backup: the last complete nightly backup is from ${stamp}, older than ${MAX_AGE_HOURS} h"
  fi
}

# One `df -P` line per path (the Capacity column is the used percentage).
check_df() {
  local label="$1" out line used
  shift
  if ! out="$("$@" 2>/dev/null)"; then
    problem "UNKNOWN disk space of ${label}: $* failed"
    return
  fi
  while IFS= read -r line; do
    used="$(awk '{ sub("%", "", $5); print $5 }' <<<"${line}")"
    if [[ ! "${used}" =~ ^[0-9]+$ ]]; then
      problem "UNKNOWN disk space of ${label}: unreadable df line: ${line}"
    elif ((100 - used < DISK_MIN)); then
      problem "disk: ${label} ($(awk '{ print $6 }' <<<"${line}")) has $((100 - used))% free, less than ${DISK_MIN}%"
    fi
  done < <(tail -n +2 <<<"${out}")
}

check_disk() {
  check_df "the Docker root and the database volume" \
    docker exec "${PROJECT}-db-1" df -P / /var/lib/postgresql/data
  check_df "the uploads volume" docker exec "${PROJECT}-cms-1" df -P /app/apps/cms/public/uploads
  local backup_dir="${SINNLOS_BACKUP_DIR:-}"
  [[ -z "${OPS_BACKUP_STATUS:-}" ]] || backup_dir="$(dirname "${OPS_BACKUP_STATUS}")"
  [[ -z "${backup_dir}" ]] || check_df "the backup directory" df -P "${backup_dir}"
  check_df "the checkout" df -P "${SCRIPT_DIR}"
}

check_cron() {
  local schema table rows kind name every first finished outcome failed enabled="" grace ts
  # The cms's schema (DATABASE_SCHEMA, default public); the container's
  # config, so a stopped cms still answers.
  if ! schema="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${PROJECT}-cms-1" 2>/dev/null)"; then
    problem "UNKNOWN cron status: docker inspect ${PROJECT}-cms-1 failed"
    return
  fi
  schema="$(sed -n 's/^DATABASE_SCHEMA=//p' <<<"${schema}")"
  schema="${schema:-public}"
  table="\"${schema//\"/\"\"}\".strapi_core_store_settings"
  if ! rows="$(docker exec -i "${PROJECT}-db-1" sh -c 'psql -X -q -t -A -F "|" -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>&1 <<SQL
with rows as (
  select key, value::jsonb as v from ${table}
   where key like 'plugin_sinnlos_cron:%' and type = 'object'
     and environment is null and tag is null
), expected as (
  select v from rows where key = 'plugin_sinnlos_cron:expected'
)
select 'expected', coalesce(v->>'cronEnabled', ''), '', '', '', '', '' from expected
union all
select 'task', t->>'name', t->>'everyMinutes', t->>'firstExpectedAt',
       coalesce(s.v->>'lastFinishedAt', ''), coalesce(s.v->>'lastOutcome', ''),
       coalesce(s.v->>'lastFailedAt', '')
  from expected cross join lateral jsonb_array_elements(expected.v->'tasks') as t
  left join rows s on s.key = 'plugin_sinnlos_cron:' || (t->>'name');
SQL
  )"; then
    problem "UNKNOWN cron status: psql in ${PROJECT}-db-1 failed: ${rows//$'\n'/ }"
    return
  fi
  while IFS='|' read -r kind name every first finished outcome failed; do
    case "${kind}" in
      expected) enabled="${name}" ;;
      task)
        if [[ ! "${every}" =~ ^[0-9]+$ ]] || ! first="$(epoch "${first}")"; then
          problem "UNKNOWN cron status: unreadable entry for task ${name}"
          continue
        fi
        grace=$((every + (every / 10 > 15 ? every / 10 : 15)))
        if [[ -z "${finished}" ]]; then
          ((NOW - first <= grace * 60)) ||
            problem "cron: ${name} has not run since it became expected (more than ${grace} min)"
        elif ! ts="$(epoch "${finished}")"; then
          problem "UNKNOWN cron status: unreadable lastFinishedAt of task ${name}"
          continue
        elif ((NOW - ts > grace * 60)); then
          problem "cron: ${name} last finished at ${finished}, more than ${grace} min ago"
        fi
        if [[ "${outcome}" == failed ]]; then
          problem "cron: ${name} failed on its last run (${finished}); see [cron] ${name} failed in the cms log"
        elif [[ -n "${failed}" ]]; then
          if ! ts="$(epoch "${failed}")"; then
            problem "UNKNOWN cron status: unreadable lastFailedAt of task ${name}"
          elif ((NOW - ts <= LOOKBACK * 60)); then
            problem "cron: ${name} failed at ${failed} (it has run fine since)"
          fi
        fi
        ;;
    esac
  done <<<"${rows}"
  if [[ -z "${enabled}" ]]; then
    problem "UNKNOWN cron status: no cron:expected entry (has the cms booted since v0.29?)"
  elif [[ "${enabled}" != true ]]; then
    problem "cron: the cms runs with CRON_ENABLED off; no task runs"
  fi
}

check_backup
check_disk
check_cron

if ((problems == 0)) && [[ -n "${OPS_PUSH_URL:-}" ]]; then
  curl -fsS --max-time 10 -o /dev/null "${OPS_PUSH_URL}" 2>/dev/null ||
    problem "UNKNOWN monitor: the push to OPS_PUSH_URL failed"
fi
((problems == 0))
