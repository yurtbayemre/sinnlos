# shellcheck shell=bash
#
# Stubs for the fast sequences of infra/restore-db.test.ts (sourced by the
# harness, never run on a host): docker (ps and compose) and flock as
# exported shell functions over a fake database.
#
#   $T/db/tables   the database, one "<table> <rows>" line per table; no
#                  $T/db directory = the database does not exist
#   $T/apps        "running" or "stopped" (web and cms)
#   $T/started-jwt sha256 of the JWT_SECRET the last `up` handed the cms
#   $T/calls       every docker call of the current step
# A fake archive (pg_dump -Fc) is FAKEDUMP, "table <name> <rows>" lines and
# END. Without END its table of contents lists, but it does not decode (a
# dump cut off in its data); a GRANT line makes its restore fail (a role
# the target lacks).
# Switches: STUB_EDGE (traefik | caddy | mixed | empty: the config_files of
# the project's containers), STUB_STOP_FAIL, STUB_UP_FAIL, STUB_PGDUMP_FAIL,
# STUB_CREATEDB_FAIL (dropdb runs, createdb fails), STUB_RESTORE_FAIL,
# STUB_LOCK_HELD.
: "${T:?}" "${REPO:?}"

# What compose hands the cms: an exported JWT_SECRET, else a compose file
# that sets it, else the last JWT_SECRET= line of infra/.env. Reads the
# caller's `files` (bash's dynamic scope: docker below).
stub_effective_jwt() {
  local f v pinned=""
  if [[ -n "${JWT_SECRET+set}" ]]; then
    printf '%s\n' "${JWT_SECRET}"
    return 0
  fi
  for f in "${files[@]}"; do
    v="$(sed -n 's/^ *JWT_SECRET: *//p' "${f}" | tail -n 1)"
    if [[ -n "${v}" ]]; then pinned="${v}"; fi
  done
  if [[ -n "${pinned}" ]]; then
    printf '%s\n' "${pinned}"
    return 0
  fi
  sed -n 's/^JWT_SECRET=//p' "${REPO}/infra/.env" | tail -n 1
}

# `compose exec -T db <command>`: pg_restore --list / --file=/dev/null, or
# sh -c '<pg_dump | dropdb && createdb | pg_restore | psql>'.
stub_db() {
  local in script r i=0 kw name rows
  if [[ "$1" == pg_restore ]]; then
    in="$(cat)"
    if [[ "$(head -n 1 <<<"${in}")" != FAKEDUMP ]]; then
      echo "pg_restore: error: input file does not appear to be a valid archive" >&2
      return 1
    fi
    if [[ "$*" == *--list* ]]; then
      while read -r kw name rows; do
        [[ "${kw}" == table ]] || continue
        i=$((i + 1))
        echo "${i}; 1259 $((16000 + i)) TABLE public ${name} sinnlos"
        echo "$((i + 100)); 0 $((16000 + i)) TABLE DATA public ${name} sinnlos ${rows}"
      done <<<"${in}"
      return 0
    fi
    if [[ "$(tail -n 1 <<<"${in}")" != END ]]; then
      echo "pg_restore: error: could not read from input file: end of file" >&2
      return 1
    fi
    return 0
  fi
  [[ "$1" == sh && "$2" == -c ]] || return 9
  script="$3"
  case "${script}" in
    *pg_dump*)
      if [[ -n "${STUB_PGDUMP_FAIL}" ]]; then
        echo "pg_dump: error: injected" >&2
        return 1
      fi
      if [[ ! -d "${T}/db" ]]; then
        echo 'pg_dump: error: database "sinnlos" does not exist' >&2
        return 1
      fi
      echo FAKEDUMP
      sed 's/^/table /' "${T}/db/tables"
      echo END
      ;;
    *dropdb*)
      rm -rf "${T}/db"
      if [[ -n "${STUB_CREATEDB_FAIL}" ]]; then
        echo 'createdb: error: injected' >&2
        return 1
      fi
      mkdir "${T}/db"
      : >"${T}/db/tables"
      ;;
    *pg_restore*)
      in="$(cat)"
      if [[ ! -d "${T}/db" ]]; then
        echo 'pg_restore: error: database "sinnlos" does not exist' >&2
        return 1
      fi
      if [[ "$(head -n 1 <<<"${in}")" != FAKEDUMP || "$(tail -n 1 <<<"${in}")" != END ]]; then
        echo "pg_restore: error: bad archive" >&2
        return 1
      fi
      # One transaction: a failure leaves the (new, empty) database as it was.
      if grep -q '^GRANT' <<<"${in}" || [[ -n "${STUB_RESTORE_FAIL}" ]]; then
        echo 'pg_restore: error: could not execute query: ERROR:  role "walk_reader" does not exist' >&2
        return 1
      fi
      grep '^table ' <<<"${in}" | cut -d' ' -f2- >"${T}/db/tables"
      ;;
    *"-d postgres"*)
      cat >/dev/null
      if [[ -d "${T}/db" ]]; then echo 1; else echo 0; fi
      ;;
    *psql*)
      in="$(cat)"
      case "${in}" in
        *pg_tables*) wc -l <"${T}/db/tables" | tr -d ' ' ;;
        *up_users*)
          r="$(awk '$1 == "up_users" { print $2 }' "${T}/db/tables")"
          if [[ -z "${r}" ]]; then
            echo 'ERROR:  relation "up_users" does not exist' >&2
            return 1
          fi
          echo "${r}"
          ;;
      esac
      ;;
    *) return 9 ;;
  esac
}

docker() {
  printf 'docker %s\n' "$*" >>"${T}/calls"
  if [[ "$1" == ps ]]; then
    local both="${REPO}/infra/docker-compose.yml,${REPO}/infra/docker-compose.traefik.yml"
    case "${STUB_EDGE}" in
      traefik) printf '%s\n%s\n' "${both}" "${both}" ;;
      caddy) echo "${REPO}/infra/docker-compose.yml" ;;
      mixed) printf '%s\n%s\n' "${REPO}/infra/docker-compose.yml" "${both}" ;;
    esac
    return 0
  fi
  [[ "$1" == compose ]] || return 9
  shift
  local files=() sub=""
  while (($#)); do
    case "$1" in
      -p) shift 2 ;;
      -f)
        files+=("$2")
        shift 2
        ;;
      *)
        sub="$1"
        shift
        break
        ;;
    esac
  done
  # Compose renders the files with infra/.env first, for every subcommand.
  if [[ ! -f "${REPO}/infra/.env" ]]; then
    echo 'required variable JWT_SECRET is missing a value' >&2
    return 14
  fi
  case "${sub}" in
    stop)
      if [[ -n "${STUB_STOP_FAIL}" ]]; then return 1; fi
      echo stopped >"${T}/apps"
      ;;
    up)
      if [[ -n "${STUB_UP_FAIL}" ]]; then return 1; fi
      stub_effective_jwt | sha256sum | cut -d' ' -f1 >"${T}/started-jwt"
      echo running >"${T}/apps"
      ;;
    config)
      printf '{\n  "services": {\n    "cms": {\n      "environment": {\n        "ADMIN_JWT_SECRET": "a\\u003cb",\n        "JWT_SECRET": "%s"\n      }\n    }\n  }\n}\n' \
        "$(stub_effective_jwt)"
      ;;
    exec)
      shift 2
      stub_db "$@"
      ;;
    *) return 9 ;;
  esac
}

flock() { [[ -z "${STUB_LOCK_HELD}" ]]; }

export -f docker stub_db stub_effective_jwt flock
