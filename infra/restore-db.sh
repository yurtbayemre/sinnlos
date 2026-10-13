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
#   infra/restore-db.sh prepare <dump>   a new attempt: checks the whole dump (it lists
#                                        at least one table and decodes to the end),
#                                        stops web and cms, writes a NEW copy of the
#                                        current database to
#                                        infra/backups/before-restore-<attempt>.dump and
#                                        checks it the same way; drops nothing
#   infra/restore-db.sh apply            the attempt's dump (same sha256, decodes) and
#                                        copy (same sha256, decodes) checked again, web
#                                        and cms stopped, dropdb --if-exists --force +
#                                        createdb, pg_restore --no-owner --exit-on-error
#                                        --single-transaction, then the database must hold
#                                        the dump's tables and at least one up_users row;
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
#                                        the attempt
#   infra/restore-db.sh rotate-jwt --env-only
#   infra/restore-db.sh start --env-only the same pair when only infra/.env was restored
#                                        (the database is intact)
#   infra/restore-db.sh status           what the current attempt has done (no secrets)
#   infra/restore-db.sh back             a new attempt from the copy of the database as it
#                                        was before the restore (prepare <that copy>)
#
# Every step clears its own result and the results after it before it does
# anything, and a result belongs to one attempt, so a failed or repeated step
# never leaves an old pass behind. The attempt lives in a state file, not in
# the shell: a new shell, a changed variable or an `exit` loses nothing.
#
# State: <common git dir>/sinnlos-restore/<project>.state (the current
# attempt; earlier ones as <project>.<attempt>.state) and
# <project>.env-only.state, mode 600, key=value, no secret (the JWT_SECRET is
# recorded as its sha256 only). One run at a time per compose project: the
# lock of infra/deploy.sh (<common git dir>/sinnlos-deploy/<project>.lock),
# so neither a second restore step nor a deploy runs during a step.
#
# Exit codes: 0 OK, 1 STOP (a check or a command failed; the STOP line says
# what changed and what to do), 2 usage, 3 another restore step or a deploy
# of the project holds the lock (nothing changed).
#
# Parameters (environment; the defaults are the owner's production host):
#   COMPOSE_PROJECT    infra (as infra/deploy.sh; a staging project has its own
#                      containers, state and lock)
#   RESTORE_EDGE       traefik (docker-compose.yml + docker-compose.traefik.yml) or
#                      caddy (docker-compose.yml alone); unset: what the project's
#                      containers were started with (their compose config_files label)
#   SINNLOS_CHECKOUT   the checkout this script lives in
#   RESTORE_STATE_DIR  <common git dir>/sinnlos-restore
#   DEPLOY_STATE_DIR   <common git dir>/sinnlos-deploy (the lock, as infra/deploy.sh)
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
  apply | status | back) (($# == 1)) || usage ;;
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
# on every exit.
ROTATE_TMP=""
cleanup() {
  # Never fails (a failing EXIT trap would set off the ERR trap); the exit
  # status stays the one the script exited with.
  if [[ -n "${ROTATE_TMP}" ]]; then rm -f "${ROTATE_TMP}" || true; fi
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
COMPOSE_BASE="${INFRA_DIR}/docker-compose.yml"
COMPOSE_TRAEFIK="${INFRA_DIR}/docker-compose.traefik.yml"

PROJECT="${COMPOSE_PROJECT:-infra}"
if ! [[ "${PROJECT}" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "STOP: COMPOSE_PROJECT must be a compose project name (lower case, digits, - and _): ${PROJECT}" >&2
  exit 2
fi

# The checkout owner runs every step: the copies, the state and infra/.env
# stay theirs (a root run would leave infra/.env unreadable for deploy.sh).
OWNER_UID="$(stat -c %u "${CHECKOUT}")"
if [[ "$(id -u)" != "${OWNER_UID}" ]]; then
  stop "run this as the owner of ${CHECKOUT} (uid ${OWNER_UID}; on the owner's host: sudo -iu bigemo), not as uid $(id -u); nothing changed"
fi

if [[ -z "${RESTORE_STATE_DIR:-}" || -z "${DEPLOY_STATE_DIR:-}" ]]; then
  if ! REPO_GIT_DIR="$(git -C "${CHECKOUT}" rev-parse --git-common-dir 2>/dev/null)"; then
    stop "${CHECKOUT} is not a git checkout (set RESTORE_STATE_DIR and DEPLOY_STATE_DIR); nothing changed"
  fi
  if [[ "${REPO_GIT_DIR}" != /* ]]; then REPO_GIT_DIR="${CHECKOUT}/${REPO_GIT_DIR}"; fi
  REPO_GIT_DIR="$(cd "${REPO_GIT_DIR}" && pwd)"
fi
STATE_DIR="${RESTORE_STATE_DIR:-${REPO_GIT_DIR}/sinnlos-restore}"
STATE_FILE="${STATE_DIR}/${PROJECT}.state"
ENV_ONLY_FILE="${STATE_DIR}/${PROJECT}.env-only.state"
LOCK_DIR="${DEPLOY_STATE_DIR:-${REPO_GIT_DIR}/sinnlos-deploy}"
LOCK_FILE="${LOCK_DIR}/${PROJECT}.lock"

# --- State files (key=value; read as data, never sourced) ---------------------
STATE_KEYS=(ATTEMPT PROJECT CHECKOUT EDGE DUMP DUMP_SHA256 DUMP_TABLES SAFETY SAFETY_SHA256
  SAFETY_TABLES ORIGIN ORIGIN_ATTEMPT BACK_OF PREPARED_AT APPLY_STARTED_AT APPLIED_AT
  RESTORED_TABLES USERS ROTATED_AT ROTATED_SUM STARTED_AT)
ENV_ONLY_KEYS=(PROJECT CHECKOUT EDGE ROTATED_AT ROTATED_SUM STARTED_AT)

clear_state() { # <prefix> <keys...>
  local prefix="$1" key
  shift
  for key in "$@"; do printf -v "${prefix}${key}" '%s' ""; done
}

read_state() { # <file> <prefix> <keys...>; S_<KEY> from the file, unknown keys ignored
  local file="$1" prefix="$2" line key value known
  shift 2
  clear_state "${prefix}" "$@"
  [[ -f "${file}" ]] || return 0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" == *=* ]] || continue
    key="${line%%=*}" value="${line#*=}"
    for known in "$@"; do
      if [[ "${key}" == "${known}" ]]; then printf -v "${prefix}${key}" '%s' "${value}"; fi
    done
  done <"${file}"
}

write_state() { # <file> <prefix> <keys...>; atomic (rename), mode 600
  local file="$1" prefix="$2" key tmp var
  shift 2
  mkdir -p "${STATE_DIR}"
  tmp="$(mktemp "${file}.XXXXXX")"
  {
    echo "# infra/restore-db.sh state (no secrets); written $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for key in "$@"; do
      var="${prefix}${key}"
      printf '%s=%s\n' "${key}" "${!var}"
    done
  } >"${tmp}"
  mv -f "${tmp}" "${file}"
}

save_attempt() { write_state "${STATE_FILE}" S_ "${STATE_KEYS[@]}"; }
save_env_only() { write_state "${ENV_ONLY_FILE}" E_ "${ENV_ONLY_KEYS[@]}"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --- Compose ------------------------------------------------------------------
# Which edge the project runs: RESTORE_EDGE, or the compose files its
# containers were created with (the config_files label compose writes).
detect_edge() {
  local labels traefik=0 plain=0 line
  case "${RESTORE_EDGE:-}" in
    traefik | caddy)
      printf '%s\n' "${RESTORE_EDGE}"
      return 0
      ;;
    "") ;;
    *)
      echo "RESTORE_EDGE must be traefik or caddy, not ${RESTORE_EDGE}"
      return 1
      ;;
  esac
  if ! labels="$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" \
    --format '{{.Label "com.docker.compose.project.config_files"}}' </dev/null)"; then
    echo "docker ps failed (is docker reachable for this user?)"
    return 1
  fi
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    if [[ "${line}" == *docker-compose.traefik.yml* ]]; then traefik=1; else plain=1; fi
  done <<<"${labels}"
  if ((traefik && plain)); then
    echo "the containers of compose project ${PROJECT} were started with and without docker-compose.traefik.yml: set RESTORE_EDGE=traefik or RESTORE_EDGE=caddy"
    return 1
  elif ((traefik)); then
    echo traefik
  elif ((plain)); then
    echo caddy
  else
    echo "compose project ${PROJECT} has no containers: set RESTORE_EDGE=traefik or RESTORE_EDGE=caddy"
    return 1
  fi
}

COMPOSE=()
EDGE=""
use_edge() { # <edge>
  EDGE="$1"
  COMPOSE=(docker compose -p "${PROJECT}" -f "${COMPOSE_BASE}")
  if [[ "${EDGE}" == traefik ]]; then COMPOSE+=(-f "${COMPOSE_TRAEFIK}"); fi
}

# The edge for a step of a recorded attempt: the recorded one, and the
# environment must not say otherwise now.
use_recorded_edge() { # <recorded edge>
  local recorded="$1" now_edge
  if ! now_edge="$(detect_edge)"; then stop "${now_edge}; ${PHASE_NOTE}"; fi
  if [[ "${now_edge}" != "${recorded}" ]]; then
    stop "the attempt runs with the ${recorded} compose files, but ${now_edge} is selected now (RESTORE_EDGE or the containers changed); run with the settings of the attempt, or start again with prepare; ${PHASE_NOTE}"
  fi
  use_edge "${recorded}"
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
  # shellcheck disable=SC2016
  compose exec -T db sh -c 'psql -X -q -tA -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -v db="$POSTGRES_DB"' \
    <<<"SELECT count(*) FROM pg_database WHERE datname = :'db';"
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

# An attempt whose apply began and that was not started: the database may be
# empty, restored but not yet checked, or restored without the new secret.
attempt_open() { [[ -n "${S_ATTEMPT}" && -n "${S_APPLY_STARTED_AT}" && -z "${S_STARTED_AT}" ]]; }

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
do_prepare() { # <dump> [back-of attempt]
  local dump="$1" back_of="${2:-}" edge n safety safety_n exists attempt prev_attempt=""
  local prev_open=0 prev_origin="" prev_origin_attempt="" dump_sum safety_sum
  PHASE_NOTE="nothing changed"
  if [[ "${dump}" == *$'\n'* ]]; then stop "the dump path holds a line break; nothing changed"; fi
  if [[ "${dump}" != /* ]]; then dump="${PWD}/${dump}"; fi
  if [[ ! -f "${dump}" || ! -r "${dump}" || ! -s "${dump}" ]]; then
    stop "${dump} is missing, empty or not readable; nothing changed"
  fi
  require_env_file
  if ! edge="$(detect_edge)"; then stop "${edge}; nothing changed"; fi
  use_edge "${edge}"
  read_state "${STATE_FILE}" S_ "${STATE_KEYS[@]}"
  if attempt_open; then
    prev_open=1 prev_origin="${S_ORIGIN}" prev_origin_attempt="${S_ORIGIN_ATTEMPT}"
  fi
  prev_attempt="${S_ATTEMPT}"

  if ! n="$(dump_tables "${dump}")" || ((n <= 0)); then
    stop "${dump} is no readable dump (it must list at least one table and decode to the end; tables: ${n:-none}); nothing changed"
  fi
  dump_sum="$(sha256_of "${dump}")"

  attempt="$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%04x' "${RANDOM}")"
  safety="${BACKUP_DIR}/before-restore-${attempt}.dump"
  if ! stop_apps; then stop "web and cms did not stop; nothing dropped"; fi
  PHASE_NOTE="web and cms are stopped; nothing dropped"

  if ! exists="$(db_exists)"; then
    stop "Postgres of project ${PROJECT} did not answer (is its db container running?); web and cms are stopped, nothing dropped"
  fi
  mkdir -p "${BACKUP_DIR}"
  if [[ "${exists}" == 0 ]]; then
    # A dropdb whose createdb failed: there is nothing to copy (or to lose).
    safety="none" safety_sum="" safety_n=""
    note "the database of project ${PROJECT} does not exist (a createdb that failed?): there is nothing to copy"
  else
    if [[ -e "${safety}" ]]; then stop "${safety} exists already; web and cms are stopped, nothing dropped"; fi
    # shellcheck disable=SC2016
    if ! (
      set -o noclobber
      compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' </dev/null >"${safety}"
    ) || [[ ! -s "${safety}" ]] || ! safety_n="$(dump_tables "${safety}")"; then
      rm -f "${safety}"
      stop "no usable copy of the current database (pg_dump or its check failed); web and cms are stopped, nothing dropped"
    fi
    safety_sum="$(sha256_of "${safety}")"
  fi

  if [[ -n "${prev_attempt}" && -f "${STATE_FILE}" ]]; then
    mv -f "${STATE_FILE}" "${STATE_DIR}/${PROJECT}.${prev_attempt}.state"
  fi
  clear_state S_ "${STATE_KEYS[@]}"
  S_ATTEMPT="${attempt}" S_PROJECT="${PROJECT}" S_CHECKOUT="${CHECKOUT}" S_EDGE="${EDGE}"
  S_DUMP="${dump}" S_DUMP_SHA256="${dump_sum}" S_DUMP_TABLES="${n}"
  S_SAFETY="${safety}" S_SAFETY_SHA256="${safety_sum}" S_SAFETY_TABLES="${safety_n}"
  S_BACK_OF="${back_of}" S_PREPARED_AT="$(now)"
  # `back` goes to the database as it was before the restore: an attempt
  # that began its apply and was not started left no state worth a copy, so
  # its origin carries over.
  if ((prev_open)); then
    S_ORIGIN="${prev_origin}" S_ORIGIN_ATTEMPT="${prev_origin_attempt}"
  else
    S_ORIGIN="${safety}" S_ORIGIN_ATTEMPT="${attempt}"
  fi
  save_attempt
  if ((prev_open)); then
    note "attempt ${prev_attempt} did not finish; back from here goes to ${S_ORIGIN} (the database before it)"
  fi
  if [[ "${safety}" == none ]]; then
    ok "attempt ${attempt}: ${dump} holds ${n} tables; web and cms stopped; no database to copy. Next: infra/restore-db.sh apply"
  else
    ok "attempt ${attempt}: ${dump} holds ${n} tables; web and cms stopped; the current database (${safety_n} tables) is saved in ${safety}. Next: infra/restore-db.sh apply"
  fi
}

cmd_prepare() {
  take_lock
  do_prepare "${DUMP_ARG}"
}

cmd_back() {
  take_lock
  read_state "${STATE_FILE}" S_ "${STATE_KEYS[@]}"
  [[ -n "${S_ATTEMPT}" ]] || stop "there is no restore attempt of project ${PROJECT} to go back from; nothing changed"
  if [[ -z "${S_ORIGIN}" || "${S_ORIGIN}" == none ]]; then
    stop "attempt ${S_ATTEMPT} has no copy of the database before it (its database did not exist); nothing changed"
  fi
  if [[ ! -f "${S_ORIGIN}" ]]; then
    stop "the copy ${S_ORIGIN} is gone; nothing changed"
  fi
  note "back: the database as it was before attempt ${S_ORIGIN_ATTEMPT}, ${S_ORIGIN}"
  do_prepare "${S_ORIGIN}" "${S_ATTEMPT}"
}

cmd_apply() {
  local n sum t u exists
  take_lock
  PHASE_NOTE="nothing dropped"
  read_state "${STATE_FILE}" S_ "${STATE_KEYS[@]}"
  [[ -n "${S_ATTEMPT}" && -n "${S_PREPARED_AT}" ]] ||
    stop "no prepared attempt of project ${PROJECT}: run infra/restore-db.sh prepare <dump> first; nothing dropped"
  [[ -z "${S_STARTED_AT}" ]] ||
    stop "attempt ${S_ATTEMPT} is used up (web and cms started at ${S_STARTED_AT}): another restore starts with prepare; nothing dropped"
  [[ "${S_CHECKOUT}" == "${CHECKOUT}" ]] ||
    stop "attempt ${S_ATTEMPT} belongs to the checkout ${S_CHECKOUT}; nothing dropped"
  require_env_file
  use_recorded_edge "${S_EDGE}"

  # This step's result and the rotation after it go first.
  S_APPLIED_AT="" S_RESTORED_TABLES="" S_USERS="" S_ROTATED_AT="" S_ROTATED_SUM=""
  save_attempt

  if [[ ! -f "${S_DUMP}" ]] || ! sum="$(sha256_of "${S_DUMP}")" || [[ "${sum}" != "${S_DUMP_SHA256}" ]]; then
    stop "the dump ${S_DUMP} is gone or changed since prepare; nothing dropped (start again with prepare)"
  fi
  if ! n="$(dump_tables "${S_DUMP}")" || [[ "${n}" != "${S_DUMP_TABLES}" ]]; then
    stop "the dump ${S_DUMP} no longer decodes or lists ${n:-no} tables instead of ${S_DUMP_TABLES}; nothing dropped"
  fi
  if [[ "${S_SAFETY}" != none ]]; then
    if [[ ! -f "${S_SAFETY}" ]] || ! sum="$(sha256_of "${S_SAFETY}")" || [[ "${sum}" != "${S_SAFETY_SHA256}" ]]; then
      stop "the copy ${S_SAFETY} is gone or changed since prepare; nothing dropped (start again with prepare, which writes a new copy)"
    fi
    if ! dump_tables "${S_SAFETY}" >/dev/null; then
      stop "the copy ${S_SAFETY} no longer decodes; nothing dropped (start again with prepare)"
    fi
  fi
  if ! stop_apps; then stop "web and cms did not stop; nothing dropped"; fi

  S_APPLY_STARTED_AT="$(now)"
  save_attempt
  PHASE_NOTE="the database may be empty or missing; do not start the apps: run infra/restore-db.sh apply again, or infra/restore-db.sh back (the copy is ${S_SAFETY})"
  # --if-exists: a retry after a dropdb whose createdb failed works.
  # shellcheck disable=SC2016
  if ! compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" --if-exists --force "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"' </dev/null; then
    if exists="$(db_exists)" && [[ "${exists}" == 0 ]]; then
      stop "the database was dropped and createdb failed: it does not exist now; fix the cause and run infra/restore-db.sh apply again (or back); do not start the apps"
    fi
    stop "dropping or creating the database failed; run infra/restore-db.sh status, fix the cause and apply again (or back); do not start the apps"
  fi
  # shellcheck disable=SC2016
  if ! compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error --single-transaction' <"${S_DUMP}"; then
    stop "pg_restore failed and rolled back: the database is empty; to go back: infra/restore-db.sh back (the copy is ${S_SAFETY}), or fix the cause and apply again; do not start the apps"
  fi
  if ! t="$(db_query <<<"SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema');")" ||
    ! u="$(db_query <<<"SELECT count(*) FROM up_users;")"; then
    stop "the check queries failed (no up_users table: not a sinnlos dump?); do not start the apps: infra/restore-db.sh back, or apply another dump"
  fi
  if ! [[ "${t}" =~ ^[0-9]+$ && "${u}" =~ ^[0-9]+$ ]] || [[ "${t}" != "${S_DUMP_TABLES}" ]] || ((u <= 0)); then
    stop "the database holds ${t:-?} tables (the dump ${S_DUMP_TABLES}) and ${u:-?} users; do not start the apps: infra/restore-db.sh back, or apply another dump"
  fi
  S_APPLIED_AT="$(now)" S_RESTORED_TABLES="${t}" S_USERS="${u}"
  save_attempt
  ok "attempt ${S_ATTEMPT}: restored ${t} tables (the dump has ${S_DUMP_TABLES}) and ${u} users into a clean database. Next: infra/restore-db.sh rotate-jwt"
}

cmd_rotate_jwt() {
  local edge new new_sum file_sum effective_sum mode owner
  take_lock
  PHASE_NOTE="JWT_SECRET is not rotated"
  if ((ENV_ONLY)); then
    if ! edge="$(detect_edge)"; then stop "${edge}; JWT_SECRET left alone"; fi
    use_edge "${edge}"
    read_state "${ENV_ONLY_FILE}" E_ "${ENV_ONLY_KEYS[@]}"
    clear_state E_ "${ENV_ONLY_KEYS[@]}"
    # shellcheck disable=SC2034 # written by save_env_only (indirect)
    E_PROJECT="${PROJECT}" E_CHECKOUT="${CHECKOUT}" E_EDGE="${EDGE}"
    save_env_only
  else
    read_state "${STATE_FILE}" S_ "${STATE_KEYS[@]}"
    if [[ -z "${S_ATTEMPT}" || -z "${S_APPLIED_AT}" || -n "${S_STARTED_AT}" ]]; then
      stop "apply did not pass for the current attempt (${S_ATTEMPT:-none}); when only infra/.env was restored: infra/restore-db.sh rotate-jwt --env-only; JWT_SECRET left alone"
    fi
    use_recorded_edge "${S_EDGE}"
    S_ROTATED_AT="" S_ROTATED_SUM=""
    save_attempt
  fi
  refuse_exported_jwt
  require_env_file
  if [[ -L "${ENV_FILE}" || "$(stat -c %u "${ENV_FILE}")" != "$(id -u)" ]]; then
    stop "${ENV_FILE} is a symlink or not owned by you (uid $(id -u)); JWT_SECRET left alone"
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
  if [[ "${mode}" != 600 || "${owner}" != "$(id -u)" || "$(env_jwt_lines)" != 1 || "${file_sum}" != "${new_sum}" ]]; then
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

cmd_start() {
  local effective sum
  take_lock
  PHASE_NOTE="web and cms not started"
  read_state "${STATE_FILE}" S_ "${STATE_KEYS[@]}"
  if ((ENV_ONLY)); then
    read_state "${ENV_ONLY_FILE}" E_ "${ENV_ONLY_KEYS[@]}"
    if [[ -z "${E_ROTATED_SUM}" || -n "${E_STARTED_AT}" ]]; then
      stop "rotate-jwt --env-only did not pass (or its start was done already); web and cms not started"
    fi
    if attempt_open; then
      stop "attempt ${S_ATTEMPT} of a database restore is not finished (its apply began at ${S_APPLY_STARTED_AT}): finish it with apply, rotate-jwt and start, or go back with back; web and cms not started"
    fi
    use_recorded_edge "${E_EDGE}"
    sum="${E_ROTATED_SUM}"
  else
    if [[ -z "${S_ATTEMPT}" || -z "${S_APPLIED_AT}" || -z "${S_ROTATED_SUM}" || -n "${S_STARTED_AT}" ]]; then
      stop "web and cms not started (attempt ${S_ATTEMPT:-none}: restored ${S_APPLIED_AT:-no}, JWT_SECRET rotated ${S_ROTATED_AT:-no}, started ${S_STARTED_AT:-no})"
    fi
    use_recorded_edge "${S_EDGE}"
    sum="${S_ROTATED_SUM}"
  fi
  refuse_exported_jwt
  require_env_file
  if ! effective="$(effective_jwt_sum)" || [[ "${effective}" != "${sum}" ]]; then
    stop "Compose would not hand the cms the rotated JWT_SECRET (infra/.env or a compose file changed since rotate-jwt): run rotate-jwt again; web and cms not started"
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
    S_STARTED_AT="$(now)"
    save_attempt
    ok "attempt ${S_ATTEMPT} complete: web and cms started on the restored database with the rotated JWT_SECRET. Delete ${BACKUP_DIR}/before-restore-*.dump once the site works"
  fi
}

cmd_status() {
  read_state "${STATE_FILE}" S_ "${STATE_KEYS[@]}"
  read_state "${ENV_ONLY_FILE}" E_ "${ENV_ONLY_KEYS[@]}"
  if [[ -z "${S_ATTEMPT}" ]]; then
    echo "no restore attempt of compose project ${PROJECT} (${STATE_FILE})"
  else
    echo "attempt ${S_ATTEMPT} of compose project ${S_PROJECT} (${S_EDGE} compose files, checkout ${S_CHECKOUT})"
    echo "  dump:      ${S_DUMP} (${S_DUMP_TABLES} tables, sha256 ${S_DUMP_SHA256})"
    if [[ "${S_SAFETY}" == none ]]; then
      echo "  copy:      none (the database did not exist at prepare)"
    else
      echo "  copy:      ${S_SAFETY} (${S_SAFETY_TABLES} tables, sha256 ${S_SAFETY_SHA256})"
    fi
    echo "  back to:   ${S_ORIGIN} (the database before attempt ${S_ORIGIN_ATTEMPT})"
    if [[ -n "${S_BACK_OF}" ]]; then echo "  goes back from attempt ${S_BACK_OF}"; fi
    echo "  prepared:  ${S_PREPARED_AT:-no}"
    echo "  apply:     began ${S_APPLY_STARTED_AT:-no}, passed ${S_APPLIED_AT:-no}${S_APPLIED_AT:+ (${S_RESTORED_TABLES} tables, ${S_USERS} users)}"
    echo "  rotated:   ${S_ROTATED_AT:-no}"
    echo "  started:   ${S_STARTED_AT:-no}"
    if [[ -n "${S_STARTED_AT}" ]]; then
      echo "  next:      nothing (done); another restore starts with prepare"
    elif [[ -n "${S_ROTATED_AT}" ]]; then
      echo "  next:      infra/restore-db.sh start"
    elif [[ -n "${S_APPLIED_AT}" ]]; then
      echo "  next:      infra/restore-db.sh rotate-jwt"
    elif [[ -n "${S_APPLY_STARTED_AT}" ]]; then
      echo "  next:      the apply did not pass, the database may be empty: apply again, or back; do not start the apps"
    else
      echo "  next:      infra/restore-db.sh apply"
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
esac
