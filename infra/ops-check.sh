#!/usr/bin/env bash
#
# ops-check.sh: the host check behind the documented alerts (v0.29, S8;
# docs/OPERATIONS.md, Monitoring). Silent and exit 0 when everything is in
# order; otherwise one line per problem on stdout and exit 1, so a cron
# line with MAILTO mails exactly the problems:
#   0 * * * * /path/to/infra/ops-check.sh
# A line starting with UNKNOWN is a check that could not be made (a failed
# docker, df or psql call, a missing file, a value of the wrong shape, a time
# that is not an ISO time or lies in the future); it counts as a problem: a
# check that cannot look must not report "clean".
#
#  1. Backup age: the newest complete nightly backup, from
#     $SINNLOS_BACKUP_DIR/offsite/sinnlos/last-success (pg-backup.sh) or,
#     with OPS_BACKUP_STATUS, backup-run's `backup-status` file
#     (daily_last_ok_at=), is at most OPS_BACKUP_MAX_AGE_HOURS (26) old.
#  2. Disk: at least OPS_DISK_MIN_PERCENT (15) free on Docker's root
#     directory, the database and uploads volumes (seen from their
#     containers, so no root is needed), the backup directories and the
#     checkout's infra/backups (restore-db.sh's safety dumps).
#  3. Cron: the status the cms keeps in its core store (apps/cms/src/cron/
#     cron-status.ts; the query is infra/ops-check.sql, run with psql in the
#     db container): cron is on, every expected task ran within its interval
#     + max(15 min, a tenth of it) (after a grace of that length once it
#     became expected), none failed on its last run, none failed within
#     OPS_CRON_LOOKBACK_MINUTES (120).
#
# Clean, with OPS_PUSH_URL set (an Uptime Kuma push URL, for example), it
# calls that URL; a failed push is a problem too, so a host check that
# cannot reach its monitor still mails. Containers: <COMPOSE_PROJECT>-db-1
# and -cms-1, as infra/mfa-reset.sh. Environment: COMPOSE_PROJECT (infra)
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
ISO_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
problems=0

problem() {
  echo "$*"
  problems=$((problems + 1))
}

# An ISO time (as pg-backup.sh and the cms write it) as epoch seconds; status
# 1 for anything else (GNU date alone would take "now" or "tomorrow") and
# for a time more than five minutes ahead.
epoch() {
  local t
  [[ "$1" =~ ${ISO_RE} ]] || return 1
  t="$(date -u -d "$1" +%s 2>/dev/null)" || return 1
  ((t <= NOW + 300)) || return 1
  echo "${t}"
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

# `check_df LABEL COMMAND…` for a `df -P` of exactly one path: exactly one
# data row, whose Capacity column (the used percentage) leaves enough free.
check_df() {
  local label="$1" out rows used
  shift
  if ! out="$("$@" 2>/dev/null)"; then
    problem "UNKNOWN disk space of ${label}: $* failed"
    return
  fi
  rows="$(tail -n +2 <<<"${out}" | grep -c .)"
  used="$(tail -n +2 <<<"${out}" | awk 'NR == 1 { sub("%", "", $5); print $5 }')"
  if [[ "${rows}" != 1 || ! "${used}" =~ ^[0-9]+$ ]]; then
    problem "UNKNOWN disk space of ${label}: $* printed no single usable row"
  elif ((100 - used < DISK_MIN)); then
    problem "disk: ${label} has $((100 - used))% free, less than ${DISK_MIN}%"
  fi
}

check_disk() {
  local root dumps="${SCRIPT_DIR}/backups"
  if root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null)" && [[ -n "${root}" ]]; then
    check_df "Docker's root ${root}" df -P "${root}"
  else
    problem "UNKNOWN disk space of Docker's root: docker info failed"
  fi
  check_df "the database volume" docker exec "${PROJECT}-db-1" df -P /var/lib/postgresql/data
  check_df "the uploads volume" docker exec "${PROJECT}-cms-1" df -P /app/apps/cms/public/uploads
  [[ -z "${SINNLOS_BACKUP_DIR:-}" ]] ||
    check_df "the backup directory ${SINNLOS_BACKUP_DIR}" df -P "${SINNLOS_BACKUP_DIR}"
  [[ -z "${OPS_BACKUP_STATUS:-}" ]] ||
    check_df "the backup-run directory" df -P "$(dirname "${OPS_BACKUP_STATUS}")"
  [[ -d "${dumps}" ]] || dumps="${SCRIPT_DIR}"
  check_df "the safety dumps ${dumps}" df -P "${dumps}"
}

# One task row of ops-check.sql: freshness, last outcome, recent failure.
check_task() {
  local name="$1" every="$2" first="$3" present="$4" finished="$5" outcome="$6" failed="$7"
  local grace first_ts ts failed_ts=""
  if [[ -z "${name}" || ! "${every}" =~ ^[1-9][0-9]*$ ]] || ! first_ts="$(epoch "${first}")"; then
    problem "UNKNOWN cron status: unreadable expected entry for task '${name}'"
    return
  fi
  grace=$((every + (every / 10 > 15 ? every / 10 : 15)))
  if [[ "${present}" == no ]]; then
    ((NOW - first_ts <= grace * 60)) ||
      problem "cron: ${name} has not run since it became expected (more than ${grace} min)"
    return
  fi
  if ! ts="$(epoch "${finished}")" || [[ "${outcome}" != ok && "${outcome}" != failed ]] ||
    { [[ -n "${failed}" ]] && ! failed_ts="$(epoch "${failed}")"; }; then
    problem "UNKNOWN cron status: unreadable status of task ${name}"
    return
  fi
  ((NOW - ts <= grace * 60)) ||
    problem "cron: ${name} last finished at ${finished}, more than ${grace} min ago"
  if [[ "${outcome}" == failed ]]; then
    problem "cron: ${name} failed on its last run (${finished}); see [cron] ${name} failed in the cms log"
  elif [[ -n "${failed_ts}" ]] && ((NOW - failed_ts <= LOOKBACK * 60)); then
    problem "cron: ${name} failed at ${failed} (it has run fine since)"
  fi
}

check_cron() {
  local env schema rows kind a b c d e f g seen=0 enabled="" tasks_type="" tasks_count=""
  # The cms's schema (DATABASE_SCHEMA, default public), from the container's
  # config, so a stopped cms still answers.
  if ! env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${PROJECT}-cms-1" 2>/dev/null)"; then
    problem "UNKNOWN cron status: docker inspect ${PROJECT}-cms-1 failed"
    return
  fi
  schema="$(sed -n 's/^DATABASE_SCHEMA=//p' <<<"${env}")"
  # The schema goes in as a psql variable (:"schema" quotes it), never into the SQL text.
  if ! rows="$(docker exec -i "${PROJECT}-db-1" sh -c 'psql -X -q -t -A -F "|" -v ON_ERROR_STOP=1 -v schema="$1" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    sh "${schema:-public}" <"${SCRIPT_DIR}/ops-check.sql" 2>&1)"; then
    problem "UNKNOWN cron status: psql in ${PROJECT}-db-1 failed: ${rows//$'\n'/ }"
    return
  fi
  while IFS='|' read -r kind a b c d e f g; do
    case "${kind}" in
      expected) seen=1 enabled="${a}" tasks_type="${b}" tasks_count="${c}" ;;
      task) check_task "${a}" "${b}" "${c}" "${d}" "${e}" "${f}" "${g}" ;;
      "") ;;
      *) problem "UNKNOWN cron status: unexpected line from psql: ${kind}" ;;
    esac
  done <<<"${rows}"
  if ((seen == 0)); then
    problem "UNKNOWN cron status: no cron:expected entry (has the cms booted since v0.29?)"
  elif [[ "${enabled}" != true && "${enabled}" != false ]] || [[ "${tasks_type}" != array ]]; then
    problem "UNKNOWN cron status: cron:expected has the wrong shape"
  elif [[ "${enabled}" == false ]]; then
    problem "cron: the cms runs with CRON_ENABLED off; no task runs"
  elif [[ "${tasks_count}" == 0 ]]; then
    problem "UNKNOWN cron status: cron:expected lists no task although cron is on"
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
