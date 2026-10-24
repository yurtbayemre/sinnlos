#!/usr/bin/env bash
set +x # first: never trace this script (rotate-jwt handles a secret), also under bash -x
#
# restore-db.sh — restores a database dump (pg_dump -Fc) of the sinnlos
# intranet into a CLEAN database of a compose project, rotates JWT_SECRET and
# starts web and cms again, in steps that each end with one "OK: …" or
# "STOP: …" line (docs/DEPLOYMENT.md §7.1, "Restoring a database dump").
#
# Run it as the owner of the checkout (on the owner's host bigemo), from any
# directory; the dump path is taken relative to the current directory.
#
#   infra/restore-db.sh prepare <dump>   a new attempt: ends the eligibility of the
#                                        attempt before it, copies the dump into the
#                                        attempt's own file (staged: from now on only
#                                        that copy is read), checks it in full (it lists
#                                        at least one table and decodes to the end),
#                                        reserves the project against infra/deploy.sh,
#                                        stops web and cms, writes a NEW copy of the
#                                        current database to
#                                        infra/backups/before-restore-<attempt>.dump and
#                                        checks it the same way; drops nothing
#   infra/restore-db.sh apply            the staged dump checked again (same sha256,
#                                        decodes), web and cms stopped, then: a database
#                                        that exists needs the attempt's checked copy
#                                        (same sha256, decodes); dropdb --if-exists
#                                        --force + createdb, pg_restore --no-owner
#                                        --exit-on-error --single-transaction of the
#                                        staged dump, then the database must hold the
#                                        dump's tables and at least one up_users row;
#                                        may be run again after a failure
#   infra/restore-db.sh rotate-jwt       after apply: a fresh JWT_SECRET (openssl rand
#                                        -base64 48) on the one JWT_SECRET= line of
#                                        infra/.env (mode 600, atomic rename), checked by
#                                        checksum in the file and in what Compose hands the
#                                        cms; refuses an exported JWT_SECRET; prints no
#                                        secret
#   infra/restore-db.sh start            after apply and rotate-jwt of the same attempt,
#                                        with the rotated secret still the one Compose
#                                        hands the cms: up -d --no-build web cms; ends
#                                        the attempt and the reservation. Run again
#                                        after a start whose cleanup did not finish (a
#                                        staged dump that could not be removed, an
#                                        interruption), it finishes only that cleanup
#   infra/restore-db.sh rotate-jwt --env-only
#   infra/restore-db.sh start --env-only the same pair when only infra/.env was restored
#                                        (the database is intact; refused while a
#                                        restore holds the reservation)
#   infra/restore-db.sh status           what the current attempt has done (no secrets)
#   infra/restore-db.sh back             a new attempt from the copy of the database as it
#                                        was before the restore (prepare <that copy>,
#                                        whose sha256 must still be the recorded one)
#   infra/restore-db.sh cancel           ends the attempt and the reservation while no
#                                        apply has begun since the reservation was taken;
#                                        drops, restores and starts nothing (web and cms
#                                        stay as they are)
#
# Every step clears its own result and the results after it before it does
# anything, and a result belongs to one attempt, so a failed or repeated step
# never leaves an old pass behind. The attempt lives in a state file, not in
# the shell: a new shell, a changed variable or an `exit` loses nothing.
#
# State: next to infra/deploy.sh's own state and lock, in its state dir
# (DEPLOY_STATE_DIR, default <common git dir>/sinnlos-deploy), so a second
# clone that deploys the same project with the same DEPLOY_STATE_DIR sees
# it: restore/ (mode 700) holds <project>.state (the current attempt;
# earlier ones as <project>.<attempt>.state), <project>.env-only.state and
# <project>.reservation, mode 600, key=value, no secret (the JWT_SECRET is
# recorded as its sha256 only). A state file is read strictly as data (never
# sourced): it must be a regular file of the checkout owner with mode 600,
# hold only known keys once each, and every value must have its form
# (attempt ids, sha256, counts, times); paths are derived from the attempt
# id, never read. The staged dump of an attempt is
# infra/backups/restore-<attempt>/dump (mode 600 in a mode-700 directory);
# it goes when the attempt ends. The reservation lasts from prepare until
# start passes or cancel; infra/deploy.sh refuses to deploy while it exists.
# Once an apply has begun, the reservation records that the database is
# unsafe (empty, half-restored, or restored without its new JWT_SECRET);
# that mark survives later prepares and back, only a start that passes (its
# attempt's apply and rotate-jwt passed) ends it, and cancel refuses while
# it is set. One run at a time per compose project: the lock of
# infra/deploy.sh (<state dir>/<project>.lock), so neither a second restore
# step nor a deploy runs during a step.
#
# Exit codes: 0 OK, 1 STOP (a check or a command failed; the STOP line says
# what changed and what to do), 2 usage, 3 another restore step or a deploy
# of the project holds the lock (nothing changed).
#
# Parameters (environment; the defaults are the owner's production host):
#   COMPOSE_PROJECT        infra (as infra/deploy.sh; a staging project has its own
#                          containers, state, reservation and lock)
#   RESTORE_COMPOSE_FILES  the compose files, ':'-separated (relative to the
#                          checkout or absolute), when the project's containers do
#                          not tell; unset: the ordered config_files label of its web
#                          and cms containers, each a known compose file of this
#                          checkout's infra/ (docker-compose.yml first, then
#                          docker-compose.traefik.yml); the legacy-zone overrides of
#                          releases before v0.25 are retired and refused
#   SINNLOS_CHECKOUT       the checkout this script lives in
#   DEPLOY_STATE_DIR       <common git dir>/sinnlos-deploy, as infra/deploy.sh: its lock,
#                          and restore/ with the attempt state and the reservation
#
set -Eeuo pipefail
umask 077

usage() {
  cat >&2 <<'USAGE'
usage: infra/restore-db.sh prepare <dump>
       infra/restore-db.sh apply
       infra/restore-db.sh rotate-jwt [--env-only]
       infra/restore-db.sh start [--env-only]
       infra/restore-db.sh status
       infra/restore-db.sh back
       infra/restore-db.sh cancel
(docs/DEPLOYMENT.md §7.1, "Restoring a database dump")
USAGE
  exit 2
}

CMD="${1:-}"
ENV_ONLY=0
DUMP_ARG=""
case "${CMD}" in
  prepare)
    (($# == 2)) && [[ -n "$2" ]] || usage
    DUMP_ARG="$2"
    ;;
  apply | status | back | cancel) (($# == 1)) || usage ;;
  rotate-jwt | start)
    if (($# == 2)) && [[ "$2" == "--env-only" ]]; then
      ENV_ONLY=1
    elif (($# != 1)); then
      usage
    fi
    ;;
  -h | --help | *) usage ;;
esac

ok() { printf 'OK: %s\n' "$*"; }
note() { printf '  %s\n' "$*"; }
stop() {
  printf 'STOP: %s\n' "$*" >&2
  exit 1
}

# What an unexpected failure (set -e) or a signal leaves behind; each step
# keeps it current, and the traps print it.
PHASE_NOTE="nothing changed"
on_error() {
  local rc="$1" line="$2"
  # A failing command inside $( ) or a pipeline: its own shell ends, and the
  # caller reports it once.
  if ((BASH_SUBSHELL > 0)); then exit "${rc}"; fi
  printf 'STOP: %s failed unexpectedly (line %s, exit %s); %s\n' "${CMD}" "${line}" "${rc}" "${PHASE_NOTE}" >&2
  exit 1
}
on_signal() {
  printf 'STOP: %s interrupted; %s\n' "${CMD}" "${PHASE_NOTE}" >&2
  exit "$1"
}
# rotate-jwt's temporary copy of infra/.env (it holds the new secret) goes
# on every exit; so does the staging directory of a prepare that did not
# pass.
ROTATE_TMP=""
STAGE_TMP=""
cleanup() {
  # Never fails (a failing EXIT trap would set off the ERR trap); the exit
  # status stays the one the script exited with.
  if [[ -n "${ROTATE_TMP}" ]]; then rm -f "${ROTATE_TMP}" || true; fi
  if [[ -n "${STAGE_TMP}" ]]; then rm -rf "${STAGE_TMP}" || true; fi
}
trap 'on_error $? $LINENO' ERR
trap cleanup EXIT
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM

# --- Paths, compose project, owner --------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKOUT="$(cd "${SINNLOS_CHECKOUT:-${SCRIPT_DIR}/..}" && pwd)"
INFRA_DIR="${CHECKOUT}/infra"
ENV_FILE="${INFRA_DIR}/.env"
BACKUP_DIR="${INFRA_DIR}/backups"
KNOWN_COMPOSE=(docker-compose.yml docker-compose.traefik.yml)
# The legacy-zone overrides of releases before v0.25, gone with v0.29: apps
# still started with one are recreated with the supported files first (or an
# attempt that started with one finishes from the old checkout).
RETIRED_COMPOSE=(docker-compose.cms-legacy-tz.yml docker-compose.web-legacy-tz.yml)

PROJECT="${COMPOSE_PROJECT:-infra}"
if ! [[ "${PROJECT}" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "STOP: COMPOSE_PROJECT must be a compose project name (lower case, digits, - and _): ${PROJECT}" >&2
  exit 2
fi

# The checkout owner runs every step: the copies, the state and infra/.env
# stay theirs (a root run would leave infra/.env unreadable for deploy.sh).
MY_UID="$(id -u)"
OWNER_UID="$(stat -c %u "${CHECKOUT}")"
if [[ "${MY_UID}" != "${OWNER_UID}" ]]; then
  stop "run this as the owner of ${CHECKOUT} (uid ${OWNER_UID}; on the owner's host: sudo -iu bigemo), not as uid ${MY_UID}; nothing changed"
fi

if [[ -z "${DEPLOY_STATE_DIR:-}" ]]; then
  if ! REPO_GIT_DIR="$(git -C "${CHECKOUT}" rev-parse --git-common-dir 2>/dev/null)"; then
    stop "${CHECKOUT} is not a git checkout (set DEPLOY_STATE_DIR, as for infra/deploy.sh); nothing changed"
  fi
  if [[ "${REPO_GIT_DIR}" != /* ]]; then REPO_GIT_DIR="${CHECKOUT}/${REPO_GIT_DIR}"; fi
  REPO_GIT_DIR="$(cd "${REPO_GIT_DIR}" && pwd)"
fi
# infra/deploy.sh's state dir: the lock, and the restore state next to it.
LOCK_DIR="${DEPLOY_STATE_DIR:-${REPO_GIT_DIR}/sinnlos-deploy}"
LOCK_FILE="${LOCK_DIR}/${PROJECT}.lock"
STATE_DIR="${LOCK_DIR}/restore"
STATE_FILE="${STATE_DIR}/${PROJECT}.state"
ENV_ONLY_FILE="${STATE_DIR}/${PROJECT}.env-only.state"
RESERVATION="${STATE_DIR}/${PROJECT}.reservation"

# --- State files (key=value; strictly parsed data, never sourced) -------------
STATE_KEYS=(ATTEMPT PROJECT CHECKOUT COMPOSE_FILES SOURCE DUMP_SHA256 DUMP_TABLES SAFETY
  SAFETY_SHA256 SAFETY_TABLES ORIGIN_ATTEMPT ORIGIN_SHA256 BACK_OF PREPARED_AT SUPERSEDED_AT
  CANCELLED_AT APPLY_STARTED_AT APPLIED_AT RESTORED_TABLES USERS ROTATED_AT ROTATED_SUM STARTED_AT)
ENV_ONLY_KEYS=(PROJECT CHECKOUT COMPOSE_FILES ROTATED_AT ROTATED_SUM STARTED_AT)
RESERVATION_KEYS=(ATTEMPT RESERVED_AT UNSAFE_SINCE UNSAFE_ATTEMPT)

ID_RE='^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{4}$'
SHA_RE='^[0-9a-f]{64}$'
TIME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'
COUNT_RE='^(0|[1-9][0-9]{0,8})$'

clear_state() { # <prefix> <keys...>
  local prefix="$1" key
  shift
  for key in "$@"; do printf -v "${prefix}${key}" '%s' ""; done
}

# Mode 700, or 2700: under a setgid home (Alpine's adduser) the directory
# inherits the setgid bit, which grants nobody access.
state_dir_ok() {
  local mode
  mode="$(stat -c %a "${STATE_DIR}")"
  [[ ! -L "${STATE_DIR}" && -d "${STATE_DIR}" && "$(stat -c %u "${STATE_DIR}")" == "${MY_UID}" &&
    ("${mode}" == 700 || "${mode}" == 2700) ]]
}

# Fails with a reason on stdout unless <file> is a regular file (no symlink)
# of the checkout owner with mode 600 in the owner's mode-700 state dir.
check_owned_file() { # <file>
  local file="$1"
  if ! state_dir_ok; then
    echo "the state directory ${STATE_DIR} is not a mode-700 directory of uid ${MY_UID}"
    return 1
  fi
  if [[ -L "${file}" || ! -f "${file}" ]]; then
    echo "${file} is not a regular file"
    return 1
  fi
  if [[ "$(stat -c %u "${file}")" != "${MY_UID}" || "$(stat -c %a "${file}")" != 600 ]]; then
    echo "${file} is not mode 600 and owned by uid ${MY_UID}"
    return 1
  fi
}

# Reads <file> into <prefix><KEY>: only known keys, each at most once, values
# without control characters; anything else stops the step. A missing file
# leaves every key empty.
read_state() { # <file> <prefix> <keys...>
  local file="$1" prefix="$2" line key value known reason k seen=" "
  shift 2
  clear_state "${prefix}" "$@"
  [[ -e "${file}" || -L "${file}" ]] || return 0
  if ! reason="$(check_owned_file "${file}")"; then
    stop "the state file ${file} is not one this script wrote (${reason}); nothing changed: look at it, then move it away and start again with prepare"
  fi
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ -n "${line}" && "${line}" != \#* ]] || continue
    key="${line%%=*}" value="${line#*=}"
    known=0
    for k in "$@"; do if [[ "${key}" == "${k}" ]]; then known=1; fi; done
    if ((!known)) || [[ "${line}" != *=* || "${seen}" == *" ${key} "* || "${value}" == *[[:cntrl:]]* ]]; then
      stop "the state file ${file} is not one this script wrote (line '${key}'); nothing changed: look at it, then move it away and start again with prepare"
    fi
    seen+="${key} "
    printf -v "${prefix}${key}" '%s' "${value}"
  done <"${file}"
}

matches() { [[ "$1" =~ $2 ]]; }
empty_or() { [[ -z "$1" ]] || [[ "$1" =~ $2 ]]; }

# Every value of the attempt state in its form; paths are derived, not read.
validate_attempt_state() {
  local bad=""
  [[ -z "${S_ATTEMPT}" ]] && return 0
  matches "${S_ATTEMPT}" "${ID_RE}" || bad="ATTEMPT"
  [[ "${S_PROJECT}" == "${PROJECT}" ]] || bad+=" PROJECT"
  [[ "${S_CHECKOUT}" == "${CHECKOUT}" ]] || bad+=" CHECKOUT"
  valid_compose_list "${S_COMPOSE_FILES}" || bad+=" COMPOSE_FILES"
  [[ "${S_SOURCE}" == /* ]] || bad+=" SOURCE"
  matches "${S_DUMP_SHA256}" "${SHA_RE}" || bad+=" DUMP_SHA256"
  matches "${S_DUMP_TABLES}" '^[1-9][0-9]{0,8}$' || bad+=" DUMP_TABLES"
  case "${S_SAFETY}" in
    yes) matches "${S_SAFETY_SHA256}" "${SHA_RE}" && matches "${S_SAFETY_TABLES}" "${COUNT_RE}" || bad+=" SAFETY" ;;
    none) [[ -z "${S_SAFETY_SHA256}${S_SAFETY_TABLES}" ]] || bad+=" SAFETY" ;;
    *) bad+=" SAFETY" ;;
  esac
  if [[ -n "${S_ORIGIN_ATTEMPT}" ]]; then
    matches "${S_ORIGIN_ATTEMPT}" "${ID_RE}" && matches "${S_ORIGIN_SHA256}" "${SHA_RE}" || bad+=" ORIGIN"
  else
    [[ -z "${S_ORIGIN_SHA256}" ]] || bad+=" ORIGIN"
  fi
  empty_or "${S_BACK_OF}" "${ID_RE}" || bad+=" BACK_OF"
  matches "${S_PREPARED_AT}" "${TIME_RE}" || bad+=" PREPARED_AT"
  local t
  for t in SUPERSEDED_AT CANCELLED_AT APPLY_STARTED_AT APPLIED_AT ROTATED_AT STARTED_AT; do
    local v="S_${t}"
    empty_or "${!v}" "${TIME_RE}" || bad+=" ${t}"
  done
  empty_or "${S_RESTORED_TABLES}" "${COUNT_RE}" || bad+=" RESTORED_TABLES"
  empty_or "${S_USERS}" "${COUNT_RE}" || bad+=" USERS"
  empty_or "${S_ROTATED_SUM}" "${SHA_RE}" || bad+=" ROTATED_SUM"
  if [[ -n "${bad}" ]]; then
    stop "the state file ${STATE_FILE} is not one this script wrote (bad: ${bad# }); nothing changed: look at it, then move it away and start again with prepare"
  fi
}

validate_env_only_state() {
  local bad=""
  [[ -z "${E_PROJECT}${E_CHECKOUT}${E_COMPOSE_FILES}${E_ROTATED_AT}${E_ROTATED_SUM}${E_STARTED_AT}" ]] && return 0
  [[ "${E_PROJECT}" == "${PROJECT}" ]] || bad+=" PROJECT"
  [[ "${E_CHECKOUT}" == "${CHECKOUT}" ]] || bad+=" CHECKOUT"
  valid_compose_list "${E_COMPOSE_FILES}" || bad+=" COMPOSE_FILES"
  empty_or "${E_ROTATED_AT}" "${TIME_RE}" || bad+=" ROTATED_AT"
  empty_or "${E_ROTATED_SUM}" "${SHA_RE}" || bad+=" ROTATED_SUM"
  empty_or "${E_STARTED_AT}" "${TIME_RE}" || bad+=" STARTED_AT"
  if [[ -n "${bad}" ]]; then
    stop "the state file ${ENV_ONLY_FILE} is not one this script wrote (bad: ${bad# }); nothing changed: look at it, then move it away"
  fi
}

load_attempt() {
  read_state "${STATE_FILE}" S_ "${STATE_KEYS[@]}"
  validate_attempt_state
}
load_env_only() {
  read_state "${ENV_ONLY_FILE}" E_ "${ENV_ONLY_KEYS[@]}"
  validate_env_only_state
}

ensure_state_dir() {
  if [[ ! -e "${STATE_DIR}" && ! -L "${STATE_DIR}" ]]; then
    mkdir -p "${LOCK_DIR}"
    mkdir -m 700 "${STATE_DIR}"
  fi
  state_dir_ok || stop "the state directory ${STATE_DIR} is not a mode-700 directory of uid ${MY_UID}; ${PHASE_NOTE}"
}

write_state() { # <file> <prefix> <keys...>; atomic (rename), mode 600
  local file="$1" prefix="$2" key tmp var
  shift 2
  ensure_state_dir
  tmp="$(mktemp "${file}.XXXXXX")"
  {
    echo "# infra/restore-db.sh state (no secrets); written $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for key in "$@"; do
      var="${prefix}${key}"
      printf '%s=%s\n' "${key}" "${!var}"
    done
  } >"${tmp}"
  chmod 600 "${tmp}"
  mv -f "${tmp}" "${file}"
}

save_attempt() { write_state "${STATE_FILE}" S_ "${STATE_KEYS[@]}"; }
save_env_only() { write_state "${ENV_ONLY_FILE}" E_ "${ENV_ONLY_KEYS[@]}"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Paths of an attempt, derived from its id.
safety_path() { printf '%s/before-restore-%s.dump\n' "${BACKUP_DIR}" "$1"; }
stage_dir() { printf '%s/restore-%s\n' "${BACKUP_DIR}" "$1"; }

# An attempt whose apply began and that was not started: the database may be
# empty, restored but not yet checked, or restored without the new secret.
attempt_open() { [[ -n "${S_ATTEMPT}" && -n "${S_APPLY_STARTED_AT}" && -z "${S_STARTED_AT}" ]]; }
# Apply, rotate-jwt and start take only the current, live attempt.
attempt_live() { [[ -n "${S_ATTEMPT}" && -z "${S_SUPERSEDED_AT}" && -z "${S_STARTED_AT}" ]]; }

reserved() { [[ -e "${RESERVATION}" || -L "${RESERVATION}" ]]; }

# The reservation, as data: R_ATTEMPT, R_RESERVED_AT, R_UNSAFE_SINCE,
# R_UNSAFE_ATTEMPT (all empty without one).
load_reservation() {
  local bad=""
  read_state "${RESERVATION}" R_ "${RESERVATION_KEYS[@]}"
  reserved || return 0
  matches "${R_ATTEMPT}" "${ID_RE}" || bad+=" ATTEMPT"
  matches "${R_RESERVED_AT}" "${TIME_RE}" || bad+=" RESERVED_AT"
  empty_or "${R_UNSAFE_SINCE}" "${TIME_RE}" || bad+=" UNSAFE_SINCE"
  empty_or "${R_UNSAFE_ATTEMPT}" "${ID_RE}" || bad+=" UNSAFE_ATTEMPT"
  if [[ -n "${bad}" ]]; then
    stop "the reservation ${RESERVATION} is not one this script wrote (bad: ${bad# }); nothing changed: look at it"
  fi
}

save_reservation() { write_state "${RESERVATION}" R_ "${RESERVATION_KEYS[@]}"; }

# Reserves the project for <attempt>; a mark of an unsafe database stays.
write_reservation() { # <attempt>
  load_reservation
  R_ATTEMPT="$1"
  if [[ -z "${R_RESERVED_AT}" ]]; then R_RESERVED_AT="$(now)"; fi
  save_reservation
}

# Before apply drops: from now on the database is unsafe until a start
# passes, whatever later prepares, backs or failures do.
mark_unsafe() { # <attempt>
  load_reservation
  if ! reserved; then
    stop "the reservation ${RESERVATION} of attempt $1 is gone (infra/deploy.sh would deploy meanwhile): run infra/restore-db.sh prepare again; nothing dropped"
  fi
  if [[ -z "${R_UNSAFE_SINCE}" ]]; then R_UNSAFE_SINCE="$(now)"; fi
  R_UNSAFE_ATTEMPT="$1"
  save_reservation
}

# --- Compose ------------------------------------------------------------------
# A list of compose files as the state keeps it: comma-separated absolute
# paths, no control characters.
valid_compose_list() { # <list>
  local list="$1" f files
  [[ -n "${list}" && "${list}" != *[[:cntrl:]]* ]] || return 1
  IFS=',' read -r -a files <<<"${list}"
  ((${#files[@]})) || return 1
  for f in "${files[@]}"; do [[ "${f}" == /* ]] || return 1; done
}

# Says why a retired compose file cannot be used, and fails; true for any other.
not_retired() { # <path>
  local k
  for k in "${RETIRED_COMPOSE[@]}"; do
    if [[ "${1##*/}" == "${k}" ]]; then
      echo "${1} is a retired compose file (the legacy-zone override of releases before v0.25, gone since v0.29): recreate web and cms with the supported files first (infra/deploy.sh, docs/UPGRADE.md), or finish a restore attempt that started with it from the checkout of that release"
      return 1
    fi
  done
}

# The project's compose files, in order, comma-separated: RESTORE_COMPOSE_FILES,
# or the config_files label of its web and cms containers (which must agree;
# the db container's when neither exists), each a known compose file of this
# checkout's infra/ that exists, docker-compose.yml first. Prints a reason
# and fails when that cannot be determined.
detect_compose_files() {
  local raw="" svc label labels=() files=() out=() f base known k infra_real
  if [[ -n "${RESTORE_COMPOSE_FILES:-}" ]]; then
    IFS=':' read -r -a files <<<"${RESTORE_COMPOSE_FILES}"
    for f in "${files[@]}"; do
      [[ -n "${f}" ]] || continue
      if [[ "${f}" != /* ]]; then f="${CHECKOUT}/${f}"; fi
      not_retired "${f}" || return 1
      if [[ "${f}" == *[,[:cntrl:]]* || -L "${f}" || ! -f "${f}" ]]; then
        echo "RESTORE_COMPOSE_FILES names ${f}, which is no regular file (or holds a comma)"
        return 1
      fi
      out+=("${f}")
    done
    if ((${#out[@]} == 0)); then
      echo "RESTORE_COMPOSE_FILES names no file"
      return 1
    fi
  else
    for svc in web cms db; do
      if ! label="$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" \
        --filter "label=com.docker.compose.service=${svc}" \
        --format '{{.Label "com.docker.compose.project.config_files"}}' </dev/null)"; then
        echo "docker ps failed (is docker reachable for this user?)"
        return 1
      fi
      labels+=("${label}")
    done
    if [[ -n "${labels[0]}" && -n "${labels[1]}" && "${labels[0]}" != "${labels[1]}" ]]; then
      echo "the web and cms containers of compose project ${PROJECT} were started with different compose files (${labels[0]} / ${labels[1]}): set RESTORE_COMPOSE_FILES"
      return 1
    fi
    raw="${labels[0]:-${labels[1]:-${labels[2]}}}"
    if [[ -z "${raw}" || "${raw}" == *$'\n'* ]]; then
      echo "the containers of compose project ${PROJECT} do not tell their compose files (none, or several of one service): set RESTORE_COMPOSE_FILES"
      return 1
    fi
    infra_real="$(readlink -f -- "${INFRA_DIR}")"
    IFS=',' read -r -a files <<<"${raw}"
    for f in "${files[@]}"; do
      not_retired "${f}" || return 1
      base="${f##*/}"
      known=0
      for k in "${KNOWN_COMPOSE[@]}"; do if [[ "${base}" == "${k}" ]]; then known=1; fi; done
      if ((!known)) || [[ "${f}" != /* || "$(readlink -f -- "${f%/*}" 2>/dev/null)" != "${infra_real}" ]]; then
        echo "the containers of compose project ${PROJECT} were started with ${f}, which is not a known compose file of ${INFRA_DIR}: set RESTORE_COMPOSE_FILES to the files to use"
        return 1
      fi
      if [[ -L "${INFRA_DIR}/${base}" || ! -f "${INFRA_DIR}/${base}" ]]; then
        echo "the containers of compose project ${PROJECT} were started with ${base}, which is missing from ${INFRA_DIR}"
        return 1
      fi
      out+=("${INFRA_DIR}/${base}")
    done
    if [[ "${out[0]##*/}" != docker-compose.yml ]]; then
      echo "the compose files of project ${PROJECT} do not begin with docker-compose.yml (${raw}): set RESTORE_COMPOSE_FILES"
      return 1
    fi
  fi
  (
    IFS=','
    printf '%s\n' "${out[*]}"
  )
}

COMPOSE=()
COMPOSE_FILES=""
use_compose_files() { # <comma-separated list>
  local f files
  COMPOSE_FILES="$1"
  COMPOSE=(docker compose -p "${PROJECT}")
  IFS=',' read -r -a files <<<"$1"
  for f in "${files[@]}"; do COMPOSE+=(-f "${f}"); done
}

# A step of a recorded attempt runs with the recorded compose files, and the
# project must still tell the same ones.
use_recorded_compose_files() { # <recorded list>
  local recorded="$1" now_files
  if ! now_files="$(detect_compose_files)"; then stop "${now_files}; ${PHASE_NOTE}"; fi
  if [[ "${now_files}" != "${recorded}" ]]; then
    stop "the attempt runs with the compose files ${recorded}, but ${now_files} are selected now (RESTORE_COMPOSE_FILES or the containers changed); run with the files of the attempt, or start again with prepare; ${PHASE_NOTE}"
  fi
  use_compose_files "${recorded}"
}

# compose exec forwards stdin: every call that needs none gets /dev/null, so a
# step run from a script or a pipe never eats the lines after it.
compose() { "${COMPOSE[@]}" "$@"; }

# --- Checks -------------------------------------------------------------------
sha256_of() { # <file>
  local sum
  sum="$(sha256sum <"$1")" || return 1
  printf '%s\n' "${sum%% *}"
}

# The tables a dump lists; fails unless the whole archive decodes (--list
# reads only the table of contents, which a dump cut off in its data still has).
dump_tables() { # <file>
  local n
  n="$(compose exec -T db pg_restore --list <"$1" | awk '$4 == "TABLE" && $5 != "DATA" { n++ } END { print n + 0 }')" || return 1
  compose exec -T db pg_restore --file=/dev/null <"$1" >/dev/null || return 1
  printf '%s\n' "${n}"
}

# psql on the project's database (SQL on stdin), stopping at the first error.
# shellcheck disable=SC2016 # $POSTGRES_USER and $POSTGRES_DB expand in the db container
db_query() { compose exec -T db sh -c 'psql -X -q -tA -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'; }

# 1 when the project's database exists, 0 when it does not (after a dropdb
# whose createdb failed); fails when Postgres cannot be asked.
db_exists() {
  local n
  # shellcheck disable=SC2016
  n="$(compose exec -T db sh -c 'psql -X -q -tA -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -v db="$POSTGRES_DB"' \
    <<<"SELECT count(*) FROM pg_database WHERE datname = :'db';")" || return 1
  [[ "${n}" == 0 || "${n}" == 1 ]] || return 1
  printf '%s\n' "${n}"
}

# v0.29 restore privacy: SITE_ALLOW_CIDRS closes the whole site at the edge
# for a restricted restore (docs/OPERATIONS.md, "Restore"): the caddy service
# gets it in its environment, the Traefik routers as the sinnlos-site-allow
# ipallowlist. Reads `compose config --format json` on stdin; true (0) when a
# value it renders is a non-empty list without an open range (one ending in
# /0, as 0.0.0.0/0 and ::/0, the defaults).
site_closed() {
  local values value entry open closed=1
  local -a entries
  values="$(awk '
    /^[ \t]*"(SITE_ALLOW_CIDRS|traefik\.http\.middlewares\.sinnlos-site-allow\.ipallowlist\.sourcerange)": / {
      v = $0; sub(/^[ \t]*"[^"]*":[ \t]*/, "", v); sub(/,[ \t]*$/, "", v)
      if (v == "null") next
      if (length(v) >= 2 && substr(v, 1, 1) == "\"" && substr(v, length(v), 1) == "\"") v = substr(v, 2, length(v) - 2)
      print v
    }')"
  while IFS= read -r value; do
    value="${value//[[:space:]]/}"
    [[ -n "${value}" ]] || continue
    open=0
    IFS=',' read -r -a entries <<<"${value}"
    for entry in "${entries[@]}"; do
      if [[ "${entry}" == */0 ]]; then open=1; fi
    done
    if ((!open)); then closed=0; fi
  done <<<"${values}"
  return "${closed}"
}

stop_apps() { compose stop web cms </dev/null; }

# Every JWT_SECRET Compose hands the cms, as one checksum; fails unless there
# is exactly one value. The rendered config (all secrets) goes through pipes
# only, never into a file or the terminal, and each value only into its
# checksum.
effective_jwt_sum() {
  local sums
  sums="$(compose config --format json cms </dev/null | awk '
    /^[ \t]*"JWT_SECRET": / {
      v = $0; sub(/^[ \t]*"JWT_SECRET":[ \t]*/, "", v); sub(/,[ \t]*$/, "", v)
      if (v == "null") v = ""
      else if (length(v) >= 2 && substr(v, 1, 1) == "\"" && substr(v, length(v), 1) == "\"") v = substr(v, 2, length(v) - 2)
      gsub(/\\u003[cC]/, "<", v); gsub(/\\u003[eE]/, ">", v); gsub(/\\u0026/, "\\&", v)
      print v
    }' | while IFS= read -r value; do printf '%s\n' "${value}" | sha256sum; done | sort -u)" || return 1
  [[ -n "${sums}" && "${sums}" != *$'\n'* ]] || return 1
  printf '%s\n' "${sums%% *}"
}

env_jwt_lines() { grep -c '^JWT_SECRET=' "${ENV_FILE}" || true; }
env_jwt_sum() {
  local sum
  sum="$(sed -n 's/^JWT_SECRET=//p' "${ENV_FILE}" | sha256sum)" || return 1
  printf '%s\n' "${sum%% *}"
}

require_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    stop "${ENV_FILE} is missing: put the backed-up file back first (owned by you, mode 600; Compose refuses stop, up and config without it); ${PHASE_NOTE}"
  fi
}

refuse_exported_jwt() {
  if [[ -n "${JWT_SECRET+set}" ]]; then
    stop "JWT_SECRET is exported in this shell, and Compose would hand it to the cms instead of infra/.env: unset JWT_SECRET, then run ${CMD} again; ${PHASE_NOTE}"
  fi
}

# A copy the script wrote: a regular file of the owner (no symlink) whose
# sha256 is still <sum> and that decodes.
copy_intact() { # <file> <sha256>
  local sum
  [[ -f "$1" && ! -L "$1" && "$(stat -c %u "$1")" == "${MY_UID}" ]] || return 1
  sum="$(sha256_of "$1")" && [[ "${sum}" == "$2" ]] && dump_tables "$1" >/dev/null
}

take_lock() {
  if ! command -v flock >/dev/null 2>&1; then
    stop "flock (util-linux) is missing; restore-db.sh holds the deploy lock so that no deploy or second restore step runs meanwhile; nothing changed"
  fi
  mkdir -p "${LOCK_DIR}"
  exec 9>>"${LOCK_FILE}"
  if ! flock -n 9; then
    printf 'STOP: another infra/restore-db.sh step or infra/deploy.sh holds the lock of compose project %s (%s); nothing changed. Let it finish, then run %s again.\n' \
      "${PROJECT}" "${LOCK_FILE}" "${CMD}" >&2
    exit 3
  fi
}

# --- Steps --------------------------------------------------------------------
# A new attempt. <source> is read once, into the attempt's own staged file;
# with <expected sha256> (back) the staged copy must have it.
do_prepare() { # <source> [back-of attempt] [expected sha256]
  local src="$1" back_of="${2:-}" expected="${3:-}" files n safety safety_n="" exists attempt
  local prev_attempt prev_open=0 prev_origin="" prev_origin_sum="" dump_sum safety_sum="" real stage
  PHASE_NOTE="nothing changed"
  load_attempt
  prev_attempt="${S_ATTEMPT}"
  if attempt_open; then
    prev_open=1 prev_origin="${S_ORIGIN_ATTEMPT}" prev_origin_sum="${S_ORIGIN_SHA256}"
  fi
  # First of all, the attempt before loses its eligibility (it stays on
  # record, for status and back): whatever happens below, apply, rotate-jwt
  # and start never act on it again.
  if [[ -n "${prev_attempt}" && -z "${S_SUPERSEDED_AT}" && -z "${S_STARTED_AT}" ]]; then
    S_SUPERSEDED_AT="$(now)"
    save_attempt
    rm -rf "$(stage_dir "${prev_attempt}")"
  fi

  if [[ "${src}" == *[[:cntrl:]]* ]]; then stop "the dump path holds a control character; nothing changed"; fi
  if [[ "${src}" != /* ]]; then src="${PWD}/${src}"; fi
  if ! real="$(readlink -f -- "${src}")" || [[ ! -f "${real}" || ! -r "${real}" || ! -s "${real}" ]]; then
    stop "${src} is missing, empty or not readable; nothing changed"
  fi
  require_env_file
  if ! files="$(detect_compose_files)"; then stop "${files}; nothing changed"; fi
  use_compose_files "${files}"

  # The staged copy: the only bytes this attempt checks and restores.
  attempt="$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%04x' "${RANDOM}")"
  stage="$(stage_dir "${attempt}")"
  if [[ ! -d "${BACKUP_DIR}" ]]; then mkdir -m 700 "${BACKUP_DIR}"; fi
  if ! mkdir -m 700 "${stage}"; then stop "${stage} exists already; nothing changed"; fi
  STAGE_TMP="${stage}"
  if ! (
    set -o noclobber
    cat <"${real}" >"${stage}/dump"
  ); then
    stop "copying ${real} into ${stage} failed; nothing changed"
  fi
  if ! n="$(dump_tables "${stage}/dump")" || ((n <= 0)); then
    stop "${src} is no readable dump (it must list at least one table and decode to the end; tables: ${n:-none}); nothing changed"
  fi
  dump_sum="$(sha256_of "${stage}/dump")"
  if [[ -n "${expected}" && "${dump_sum}" != "${expected}" ]]; then
    stop "${src} changed since it was taken (sha256 ${dump_sum}, recorded ${expected}); nothing changed"
  fi

  safety="$(safety_path "${attempt}")"
  # From here on the project is reserved: infra/deploy.sh refuses to deploy
  # until start passes or cancel.
  write_reservation "${attempt}"
  if ! stop_apps; then stop "web and cms did not stop; nothing dropped (the project is reserved: prepare again, or cancel)"; fi
  PHASE_NOTE="web and cms are stopped; nothing dropped (the project is reserved: prepare again, or cancel)"

  if ! exists="$(db_exists)"; then
    stop "Postgres of project ${PROJECT} did not answer (is its db container running?); ${PHASE_NOTE}"
  fi
  if [[ "${exists}" == 0 ]]; then
    # A dropdb whose createdb failed: there is nothing to copy (or to lose).
    safety="none"
    note "the database of project ${PROJECT} does not exist (a createdb that failed?): there is nothing to copy"
  else
    if [[ -e "${safety}" || -L "${safety}" ]]; then stop "${safety} exists already; ${PHASE_NOTE}"; fi
    # shellcheck disable=SC2016
    if ! (
      set -o noclobber
      compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' </dev/null >"${safety}"
    ) || [[ ! -s "${safety}" ]] || ! safety_n="$(dump_tables "${safety}")"; then
      rm -f "${safety}"
      stop "no usable copy of the current database (pg_dump or its check failed); ${PHASE_NOTE}"
    fi
    safety_sum="$(sha256_of "${safety}")"
  fi

  if [[ -n "${prev_attempt}" ]]; then
    mv -f "${STATE_FILE}" "${STATE_DIR}/${PROJECT}.${prev_attempt}.state"
  fi
  clear_state S_ "${STATE_KEYS[@]}"
  S_ATTEMPT="${attempt}" S_PROJECT="${PROJECT}" S_CHECKOUT="${CHECKOUT}" S_COMPOSE_FILES="${COMPOSE_FILES}"
  S_SOURCE="${real}" S_DUMP_SHA256="${dump_sum}" S_DUMP_TABLES="${n}"
  if [[ "${safety}" == none ]]; then
    S_SAFETY="none"
  else
    S_SAFETY="yes" S_SAFETY_SHA256="${safety_sum}" S_SAFETY_TABLES="${safety_n}"
  fi
  S_BACK_OF="${back_of}" S_PREPARED_AT="$(now)"
  # `back` goes to the database as it was before the restore: an attempt
  # that began its apply and was not started left no state worth a copy, so
  # its origin carries over.
  if ((prev_open)); then
    S_ORIGIN_ATTEMPT="${prev_origin}" S_ORIGIN_SHA256="${prev_origin_sum}"
  elif [[ "${safety}" != none ]]; then
    S_ORIGIN_ATTEMPT="${attempt}" S_ORIGIN_SHA256="${safety_sum}"
  fi
  save_attempt
  STAGE_TMP=""
  if ((prev_open)); then
    note "attempt ${prev_attempt} did not finish; back from here goes to $(origin_text)"
  fi
  if [[ "${safety}" == none ]]; then
    ok "attempt ${attempt}: ${real} holds ${n} tables (staged in ${stage}); web and cms stopped; no database to copy. Next: infra/restore-db.sh apply"
  else
    ok "attempt ${attempt}: ${real} holds ${n} tables (staged in ${stage}); web and cms stopped; the current database (${safety_n} tables) is saved in ${safety}. Next: infra/restore-db.sh apply"
  fi
}

origin_text() {
  if [[ -n "${S_ORIGIN_ATTEMPT}" ]]; then
    printf '%s (the database before attempt %s)\n' "$(safety_path "${S_ORIGIN_ATTEMPT}")" "${S_ORIGIN_ATTEMPT}"
  else
    printf 'none (there was no database to copy)\n'
  fi
}

cmd_prepare() {
  take_lock
  do_prepare "${DUMP_ARG}"
}

cmd_back() {
  local origin
  take_lock
  load_attempt
  [[ -n "${S_ATTEMPT}" ]] || stop "there is no restore attempt of project ${PROJECT} to go back from; nothing changed"
  if [[ -z "${S_ORIGIN_ATTEMPT}" ]]; then
    stop "attempt ${S_ATTEMPT} has no copy of the database before it (its database did not exist); nothing changed"
  fi
  origin="$(safety_path "${S_ORIGIN_ATTEMPT}")"
  if [[ -L "${origin}" || ! -f "${origin}" ]]; then
    stop "the copy ${origin} is gone; nothing changed"
  fi
  note "back: the database as it was before attempt ${S_ORIGIN_ATTEMPT}, ${origin}"
  do_prepare "${origin}" "${S_ATTEMPT}" "${S_ORIGIN_SHA256}"
}

cmd_cancel() {
  local stage
  take_lock
  load_attempt
  if ! reserved; then
    stop "compose project ${PROJECT} has no restore reservation; nothing to cancel"
  fi
  load_reservation
  if [[ -n "${R_UNSAFE_SINCE}" ]]; then
    stop "an apply began at ${R_UNSAFE_SINCE} (attempt ${R_UNSAFE_ATTEMPT}) and no start has passed since: the database may be empty, half-restored or restored without its new JWT_SECRET, so cancel refuses; finish with apply, rotate-jwt and start, or go back with back, then apply, rotate-jwt and start; nothing changed"
  fi
  if attempt_open; then
    stop "attempt ${S_ATTEMPT}'s apply began at ${S_APPLY_STARTED_AT}: the database may be empty or half-restored, so cancel refuses; finish it (apply, rotate-jwt, start) or go back (back, then apply, rotate-jwt, start); nothing changed"
  fi
  if [[ -n "${S_ATTEMPT}" && -z "${S_STARTED_AT}" ]]; then
    S_CANCELLED_AT="$(now)"
    if [[ -z "${S_SUPERSEDED_AT}" ]]; then S_SUPERSEDED_AT="${S_CANCELLED_AT}"; fi
    save_attempt
    stage="$(stage_dir "${S_ATTEMPT}")"
    rm -rf "${stage}"
  fi
  rm -f "${RESERVATION}"
  ok "restore of compose project ${PROJECT} cancelled${S_ATTEMPT:+ (attempt ${S_ATTEMPT})}: nothing was dropped or started, and infra/deploy.sh may deploy again. Web and cms stay as they are (prepare stopped them); to start them: $(start_hint)"
}

# The command that starts web and cms with the attempt's compose files.
start_hint() {
  local files f line="docker compose -p ${PROJECT}"
  if [[ -z "${S_COMPOSE_FILES}" ]]; then
    printf '%s\n' "${line} -f <the project's compose files> up -d --no-build web cms"
    return 0
  fi
  IFS=',' read -r -a files <<<"${S_COMPOSE_FILES}"
  for f in "${files[@]}"; do line+=" -f ${f}"; done
  printf '%s\n' "${line} up -d --no-build web cms"
}

cmd_apply() {
  local n sum t u exists stage
  take_lock
  PHASE_NOTE="nothing dropped"
  load_attempt
  [[ -n "${S_ATTEMPT}" ]] ||
    stop "no prepared attempt of project ${PROJECT}: run infra/restore-db.sh prepare <dump> first; nothing dropped"
  [[ -z "${S_STARTED_AT}" ]] ||
    stop "attempt ${S_ATTEMPT} is used up (web and cms started at ${S_STARTED_AT}): another restore starts with prepare; nothing dropped"
  [[ -z "${S_SUPERSEDED_AT}" ]] ||
    stop "attempt ${S_ATTEMPT} was ended at ${S_SUPERSEDED_AT} (a later prepare, back or cancel): run infra/restore-db.sh prepare <dump> (or back) again; nothing dropped"
  require_env_file
  use_recorded_compose_files "${S_COMPOSE_FILES}"

  # This step's result and the rotation after it go first.
  S_APPLIED_AT="" S_RESTORED_TABLES="" S_USERS="" S_ROTATED_AT="" S_ROTATED_SUM=""
  save_attempt

  # The staged dump, opened once: every check and the restore read this
  # inode, whatever happens to its path meanwhile.
  stage="$(stage_dir "${S_ATTEMPT}")/dump"
  if [[ -L "${stage}" || ! -f "${stage}" || "$(stat -c %u "${stage}")" != "${MY_UID}" ]]; then
    stop "the staged dump ${stage} is gone; nothing dropped (start again with prepare)"
  fi
  exec 7<"${stage}"
  if ! sum="$(sha256_of /dev/fd/7)" || [[ "${sum}" != "${S_DUMP_SHA256}" ]]; then
    stop "the staged dump ${stage} changed since prepare; nothing dropped (start again with prepare)"
  fi
  if ! n="$(dump_tables /dev/fd/7)" || [[ "${n}" != "${S_DUMP_TABLES}" ]]; then
    stop "the staged dump ${stage} no longer decodes or lists ${n:-no} tables instead of ${S_DUMP_TABLES}; nothing dropped"
  fi
  if ! stop_apps; then stop "web and cms did not stop; nothing dropped"; fi

  # With the apps stopped and the lock held: a database that exists now is
  # dropped only with the attempt's own, intact copy of it.
  if ! exists="$(db_exists)"; then
    stop "Postgres of project ${PROJECT} did not answer (is its db container running?); nothing dropped"
  fi
  if [[ "${exists}" == 1 ]]; then
    if [[ "${S_SAFETY}" != yes ]]; then
      stop "the database of project ${PROJECT} exists now, but prepare found none and took no copy of it: run infra/restore-db.sh prepare <dump> again (it copies the database first); nothing dropped"
    fi
    if ! copy_intact "$(safety_path "${S_ATTEMPT}")" "${S_SAFETY_SHA256}"; then
      stop "the copy $(safety_path "${S_ATTEMPT}") is gone, changed or no longer decodes; nothing dropped (start again with prepare, which writes a new copy)"
    fi
  elif [[ "${S_SAFETY}" == yes ]] && ! copy_intact "$(safety_path "${S_ATTEMPT}")" "${S_SAFETY_SHA256}"; then
    stop "the copy $(safety_path "${S_ATTEMPT}") is gone, changed or no longer decodes; nothing dropped (start again with prepare)"
  fi

  mark_unsafe "${S_ATTEMPT}"
  S_APPLY_STARTED_AT="$(now)"
  save_attempt
  PHASE_NOTE="the database may be empty or missing; do not start the apps: run infra/restore-db.sh apply again, or infra/restore-db.sh back (to $(origin_text))"
  # --if-exists: a retry after a dropdb whose createdb failed works.
  # shellcheck disable=SC2016
  if ! compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"' </dev/null; then
    if exists="$(db_exists)" && [[ "${exists}" == 0 ]]; then
      stop "the database was dropped and createdb failed: it does not exist now; fix the cause and run infra/restore-db.sh apply again (or back); do not start the apps"
    fi
    stop "dropping or creating the database failed; run infra/restore-db.sh status, fix the cause and apply again (or back); do not start the apps"
  fi
  # shellcheck disable=SC2016
  if ! compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error --single-transaction' </dev/fd/7; then
    stop "pg_restore failed and rolled back: the database is empty; to go back: infra/restore-db.sh back (to $(origin_text)), or fix the cause and apply again; do not start the apps"
  fi
  exec 7<&-
  if ! t="$(db_query <<<"SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');")" ||
    ! u="$(db_query <<<"SELECT count(*) FROM up_users;")"; then
    stop "the check queries failed (no up_users table: not a sinnlos dump?); do not start the apps: infra/restore-db.sh back, or apply another dump"
  fi
  if ! [[ "${t}" =~ ${COUNT_RE} && "${u}" =~ ${COUNT_RE} ]] || [[ "${t}" != "${S_DUMP_TABLES}" ]] || ((u <= 0)); then
    stop "the database holds ${t:-?} tables (the dump ${S_DUMP_TABLES}) and ${u:-?} users; do not start the apps: infra/restore-db.sh back, or apply another dump"
  fi
  S_APPLIED_AT="$(now)" S_RESTORED_TABLES="${t}" S_USERS="${u}"
  save_attempt
  ok "attempt ${S_ATTEMPT}: restored ${t} tables (the dump has ${S_DUMP_TABLES}) and ${u} users into a clean database. Next: infra/restore-db.sh rotate-jwt"
}

cmd_rotate_jwt() {
  local files new new_sum file_sum effective_sum mode owner
  take_lock
  PHASE_NOTE="JWT_SECRET is not rotated"
  if ((ENV_ONLY)); then
    load_env_only
    if ! files="$(detect_compose_files)"; then stop "${files}; JWT_SECRET left alone"; fi
    use_compose_files "${files}"
    clear_state E_ "${ENV_ONLY_KEYS[@]}"
    # shellcheck disable=SC2034 # written by save_env_only (indirect)
    E_PROJECT="${PROJECT}" E_CHECKOUT="${CHECKOUT}" E_COMPOSE_FILES="${COMPOSE_FILES}"
    save_env_only
  else
    load_attempt
    if ! attempt_live || [[ -z "${S_APPLIED_AT}" ]]; then
      stop "apply did not pass for the current attempt (${S_ATTEMPT:-none}${S_SUPERSEDED_AT:+, ended ${S_SUPERSEDED_AT}}); when only infra/.env was restored: infra/restore-db.sh rotate-jwt --env-only; JWT_SECRET left alone"
    fi
    use_recorded_compose_files "${S_COMPOSE_FILES}"
    S_ROTATED_AT="" S_ROTATED_SUM=""
    save_attempt
  fi
  refuse_exported_jwt
  require_env_file
  if [[ -L "${ENV_FILE}" || "$(stat -c %u "${ENV_FILE}")" != "${MY_UID}" ]]; then
    stop "${ENV_FILE} is a symlink or not owned by you (uid ${MY_UID}); JWT_SECRET left alone"
  fi
  if [[ "$(env_jwt_lines)" != 1 ]]; then
    stop "${ENV_FILE} needs exactly one JWT_SECRET= line (it has $(env_jwt_lines)); nothing written"
  fi

  set +x
  new="$(openssl rand -base64 48 | tr -d '\n')"
  if [[ ! "${new}" =~ ^[A-Za-z0-9+/]{64}$ ]]; then
    new=""
    stop "openssl rand did not give a new value; nothing written"
  fi
  new_sum="$(printf '%s\n' "${new}" | sha256sum)"
  new_sum="${new_sum%% *}"
  ROTATE_TMP="$(mktemp "${ENV_FILE}.rotate.XXXXXX")"
  # The value reaches awk through its environment, never its command line.
  if ! NEW_JWT_SECRET="${new}" awk '/^JWT_SECRET=/ { print "JWT_SECRET=" ENVIRON["NEW_JWT_SECRET"]; next } { print }' \
    "${ENV_FILE}" >"${ROTATE_TMP}" || ! chmod 600 "${ROTATE_TMP}" || ! mv -f "${ROTATE_TMP}" "${ENV_FILE}"; then
    new=""
    stop "writing ${ENV_FILE} failed; JWT_SECRET not rotated"
  fi
  ROTATE_TMP="" new=""
  PHASE_NOTE="infra/.env holds a new JWT_SECRET, not yet verified: run rotate-jwt again; do not start the apps"

  mode="$(stat -c %a "${ENV_FILE}")"
  owner="$(stat -c %u "${ENV_FILE}")"
  file_sum="$(env_jwt_sum)"
  if [[ "${mode}" != 600 || "${owner}" != "${MY_UID}" || "$(env_jwt_lines)" != 1 || "${file_sum}" != "${new_sum}" ]]; then
    stop "${ENV_FILE} does not hold the new JWT_SECRET as written (mode ${mode}, owner ${owner}, $(env_jwt_lines) JWT_SECRET lines); do not start the apps"
  fi
  if ! effective_sum="$(effective_jwt_sum)" || [[ "${effective_sum}" != "${new_sum}" ]]; then
    stop "infra/.env holds the new JWT_SECRET, but Compose hands the cms another value or none (a compose file that sets JWT_SECRET, or COMPOSE_ENV_FILES?): remove that, then rotate-jwt again; do not start the apps"
  fi
  if ((ENV_ONLY)); then
    E_ROTATED_AT="$(now)" E_ROTATED_SUM="${new_sum}"
    save_env_only
    ok "JWT_SECRET rotated (infra/.env only): infra/.env mode 600 with one new JWT_SECRET line, and Compose hands the cms that value. Next: infra/restore-db.sh start --env-only"
  else
    S_ROTATED_AT="$(now)" S_ROTATED_SUM="${new_sum}"
    save_attempt
    ok "attempt ${S_ATTEMPT}: JWT_SECRET rotated: infra/.env mode 600 with one new JWT_SECRET line, and Compose hands the cms that value. Next: infra/restore-db.sh start"
  fi
}

# After a start of the current attempt (STARTED_AT saved): its staged dump
# goes, and so do its unsafe mark and the reservation, as far as they are
# its own (a later prepare that failed may have reserved anew). Touches no
# database and no container, so a start that stopped here (a cleanup that
# failed, an interruption) is finished by running start again.
finish_started() {
  local stage
  stage="$(stage_dir "${S_ATTEMPT}")"
  PHASE_NOTE="web and cms run on the restored database with the rotated JWT_SECRET (attempt ${S_ATTEMPT}, started ${S_STARTED_AT}), but its cleanup did not finish: fix the cause, then run infra/restore-db.sh start again, which finishes only the cleanup"
  if [[ -e "${stage}" || -L "${stage}" ]]; then
    if ! rm -rf -- "${stage}" || [[ -e "${stage}" || -L "${stage}" ]]; then
      stop "removing the staged dump ${stage} failed; ${PHASE_NOTE}"
    fi
  fi
  if reserved; then
    load_reservation
    if [[ "${R_ATTEMPT}" == "${S_ATTEMPT}" ]]; then
      if ! rm -f -- "${RESERVATION}" || reserved; then
        stop "removing the reservation ${RESERVATION} failed; ${PHASE_NOTE}"
      fi
    elif [[ "${R_UNSAFE_ATTEMPT}" == "${S_ATTEMPT}" ]]; then
      # The reservation is a later prepare's: only this attempt's mark goes.
      R_UNSAFE_SINCE="" R_UNSAFE_ATTEMPT=""
      save_reservation
      note "the reservation belongs to attempt ${R_ATTEMPT} (a later prepare): it stays; the unsafe mark of attempt ${S_ATTEMPT} is gone"
    fi
  fi
}

# A started attempt whose cleanup is left: its staged dump, or a
# reservation or an unsafe mark of its own.
cleanup_left() {
  local stage
  [[ -n "${S_ATTEMPT}" && -n "${S_STARTED_AT}" ]] || return 1
  stage="$(stage_dir "${S_ATTEMPT}")"
  [[ -e "${stage}" || -L "${stage}" ]] && return 0
  reserved || return 1
  load_reservation
  [[ "${R_ATTEMPT}" == "${S_ATTEMPT}" || "${R_UNSAFE_ATTEMPT}" == "${S_ATTEMPT}" ]]
}

cmd_start() {
  local effective sum
  take_lock
  PHASE_NOTE="web and cms not started"
  load_attempt
  if ((!ENV_ONLY)) && cleanup_left; then
    finish_started
    ok "attempt ${S_ATTEMPT} complete: web and cms were started at ${S_STARTED_AT}; its cleanup is finished now (staged dump and reservation gone; database and containers untouched). Delete ${BACKUP_DIR}/before-restore-*.dump once the site works"
    return 0
  fi
  if ((ENV_ONLY)); then
    load_env_only
    if [[ -z "${E_ROTATED_SUM}" || -n "${E_STARTED_AT}" ]]; then
      stop "rotate-jwt --env-only did not pass (or its start was done already); web and cms not started"
    fi
    if reserved || attempt_open; then
      stop "a database restore of compose project ${PROJECT} holds the reservation (attempt ${S_ATTEMPT:-unknown}): finish it with apply, rotate-jwt and start, go back with back, or end it with cancel; web and cms not started"
    fi
    use_recorded_compose_files "${E_COMPOSE_FILES}"
    sum="${E_ROTATED_SUM}"
  else
    if ! attempt_live || [[ -z "${S_APPLIED_AT}" || -z "${S_ROTATED_SUM}" ]]; then
      stop "web and cms not started (attempt ${S_ATTEMPT:-none}: restored ${S_APPLIED_AT:-no}, JWT_SECRET rotated ${S_ROTATED_AT:-no}, started ${S_STARTED_AT:-no}${S_SUPERSEDED_AT:+, ended ${S_SUPERSEDED_AT}})"
    fi
    use_recorded_compose_files "${S_COMPOSE_FILES}"
    sum="${S_ROTATED_SUM}"
  fi
  refuse_exported_jwt
  require_env_file
  if ! effective="$(effective_jwt_sum)" || [[ "${effective}" != "${sum}" ]]; then
    stop "Compose would not hand the cms the rotated JWT_SECRET (infra/.env or a compose file changed since rotate-jwt): run rotate-jwt again; web and cms not started"
  fi
  # Advisory only: a restore that must repeat anonymisations runs with the
  # site closed first (docs/OPERATIONS.md, "Restore").
  if ! compose config --format json </dev/null 2>/dev/null | site_closed; then
    note "The site will be public. If anonymisations must be repeated, close it first (docs/OPERATIONS.md, \"Restore\")."
  fi
  PHASE_NOTE="web and cms may not be (all) up: run start again"
  if ! compose up -d --no-build web cms </dev/null; then
    stop "up -d --no-build web cms failed; fix the cause and run start again"
  fi
  if ((ENV_ONLY)); then
    E_STARTED_AT="$(now)"
    save_env_only
    ok "web and cms started with the rotated JWT_SECRET (infra/.env only)"
  else
    PHASE_NOTE="web and cms run on the restored database with the rotated JWT_SECRET, but the attempt is not recorded as started: run infra/restore-db.sh start again"
    S_STARTED_AT="$(now)"
    save_attempt
    finish_started
    ok "attempt ${S_ATTEMPT} complete: web and cms started on the restored database with the rotated JWT_SECRET; the reservation is gone. Delete ${BACKUP_DIR}/before-restore-*.dump once the site works"
  fi
}

cmd_status() {
  load_attempt
  load_env_only
  if [[ -z "${S_ATTEMPT}" ]]; then
    echo "no restore attempt of compose project ${PROJECT} (${STATE_FILE})"
  else
    echo "attempt ${S_ATTEMPT} of compose project ${S_PROJECT} (checkout ${S_CHECKOUT})"
    echo "  compose:   ${S_COMPOSE_FILES}"
    echo "  dump:      ${S_SOURCE} (${S_DUMP_TABLES} tables, sha256 ${S_DUMP_SHA256}; staged in $(stage_dir "${S_ATTEMPT}"))"
    if [[ "${S_SAFETY}" == none ]]; then
      echo "  copy:      none (the database did not exist at prepare)"
    else
      echo "  copy:      $(safety_path "${S_ATTEMPT}") (${S_SAFETY_TABLES} tables, sha256 ${S_SAFETY_SHA256})"
    fi
    echo "  back to:   $(origin_text)"
    if [[ -n "${S_BACK_OF}" ]]; then echo "  goes back from attempt ${S_BACK_OF}"; fi
    echo "  prepared:  ${S_PREPARED_AT:-no}"
    echo "  apply:     began ${S_APPLY_STARTED_AT:-no}, passed ${S_APPLIED_AT:-no}${S_APPLIED_AT:+ (${S_RESTORED_TABLES} tables, ${S_USERS} users)}"
    echo "  rotated:   ${S_ROTATED_AT:-no}"
    echo "  started:   ${S_STARTED_AT:-no}"
    if [[ -n "${S_SUPERSEDED_AT}" ]]; then
      echo "  ended:     ${S_SUPERSEDED_AT}${S_CANCELLED_AT:+ (cancelled)} (apply, rotate-jwt and start refuse it)"
    fi
    if [[ -n "${S_STARTED_AT}" ]]; then
      echo "  next:      nothing (done); another restore starts with prepare"
    elif attempt_open; then
      if [[ -n "${S_ROTATED_AT}" && -z "${S_SUPERSEDED_AT}" ]]; then
        echo "  next:      infra/restore-db.sh start"
      elif [[ -n "${S_APPLIED_AT}" && -z "${S_SUPERSEDED_AT}" ]]; then
        echo "  next:      infra/restore-db.sh rotate-jwt"
      else
        echo "  next:      the database may be empty or not yet checked: apply again, or back (or prepare another dump); do not start the apps"
      fi
    elif [[ -n "${S_SUPERSEDED_AT}" ]]; then
      echo "  next:      infra/restore-db.sh prepare <dump> (or back)"
    else
      echo "  next:      infra/restore-db.sh apply (or cancel)"
    fi
  fi
  if reserved; then
    load_reservation
    echo "reserved:  ${RESERVATION} since ${R_RESERVED_AT} (attempt ${R_ATTEMPT}; infra/deploy.sh refuses to deploy until start passes or cancel)"
    if [[ -n "${R_UNSAFE_SINCE}" ]]; then
      echo "unsafe:    since ${R_UNSAFE_SINCE}, when the apply of attempt ${R_UNSAFE_ATTEMPT} began: only a start that passes ends it; cancel refuses"
    fi
  fi
  if [[ -n "${E_ROTATED_AT}" ]]; then
    echo "infra/.env only: JWT_SECRET rotated ${E_ROTATED_AT}, started ${E_STARTED_AT:-no}"
  fi
}

case "${CMD}" in
  prepare) cmd_prepare ;;
  apply) cmd_apply ;;
  rotate-jwt) cmd_rotate_jwt ;;
  start) cmd_start ;;
  status) cmd_status ;;
  back) cmd_back ;;
  cancel) cmd_cancel ;;
esac
