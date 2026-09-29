#!/usr/bin/env bash
#
# deploy.sh — direct deploy for the 'sinnlos' intranet (docker compose project 'infra').
#
# What it does, in order:
#   0. Preflight of infra/.env against the env contract (FX13): required
#      keys set, no template placeholder in the secrets, digest sender set
#      when SMTP is, JWT_SECRET rotated when the running web still exposed
#      Strapi JWTs (D-SESSION-01), a valid Entra configuration when
#      ENTRA_ENABLED=1 (D-ENTRA-01: cms and web would refuse to start),
#      DATETIME_LEGACY_ZONE set while the running database still holds
#      pre-contract datetime columns (the new cms would refuse to start).
#      Then the deploy checks (FX35): one deploy per compose project at a
#      time (flock), a clean checkout (no changed tracked file), and the
#      GitHub CI result of the commit (a warning, or a refusal with
#      --require-green-ci). Fails before anything is touched.
#   1. Pre-deploy backup (infra/backup/pg-backup.sh; its artifacts are named
#      -predeploy and kept apart from the nightly ones). Skipped only on a
#      first install (no db container and no database volume yet).
#   2. The rollback target: the images of the last-known-good deploy,
#      <project>-{web,cms}:<sha> from the state file (below). Without a usable
#      state (the first run of this version of the script, or those images
#      are gone) the running images are tagged :rollback, as before. The
#      running images are also tagged :pre-deploy, on every run, so they
#      stay resolvable through the build (keep_running_images).
#   3. Build web and cms (without BuildKit's default attestations, so an
#      unchanged rebuild keeps its image id), then restart the stack with
#      the Traefik override.
#   4. Curl smoke check of the live site, then infra/live-smoke.sh.
#   5. Only after both passed: tag the images <project>-{web,cms}:<sha> (the
#      first 12 characters of the commit), record them as last-known-good in
#      the state file, and prune older SHA tags (DEPLOY_KEEP_TAGS, 5). A
#      live-smoke that was skipped for want of the demo credentials file
#      records nothing (--record-without-live-smoke records anyway); one
#      skipped for LIVE_EVENTS_DISABLED=1, or the datetime check alone on an
#      Entra-only instance, counts as passed.
# Any failure from step 3 on prints the rollback commands for the target of
# step 2 (an ERR trap catches the unexpected ones, tagging included); before
# step 3 the running containers are untouched.
#
# Re-run safe. Stops on the first error (set -Eeuo pipefail).
#
# Usage:
#   infra/deploy.sh                     # preflight + full deploy
#   infra/deploy.sh --check             # env preflight only (validate infra/.env), deploys nothing
#   infra/deploy.sh --dry-run           # every check, then the plan; changes nothing
#   infra/deploy.sh --require-green-ci  # refuse a commit without green GitHub CI
#   infra/deploy.sh --record-without-live-smoke
#                                       # record it as last-known-good although
#                                       # live-smoke lacked the demo credentials
#
# Parameters (environment; the defaults are the owner's production host):
#   SMOKE_URL         https://sinnlos.yurtbay.dev (smoke check and live-smoke)
#   PASSWORDS_FILE    /home/bigemo/.sinnlos-env-backup/demo-account-passwords.txt
#   SINNLOS_CHECKOUT  the checkout this script lives in (compose files, git)
#   COMPOSE_PROJECT   infra (containers <project>-web-1 …, images <project>-web …);
#                     another project also needs SMOKE_URL, SINNLOS_BACKUP_DIR
#                     and, next to project infra's containers,
#                     DEPLOY_SEPARATE_EDGE=1 (a Traefik of its own)
#   DEPLOY_STATE_DIR  <git dir of the checkout>/sinnlos-deploy (state, history, lock)
#   DEPLOY_KEEP_TAGS  5 (SHA tags kept per image)
#   GITHUB_TOKEN      optional, for the CI check (public repos need none)
#
set -Eeuo pipefail

CHECK_ONLY=0
DRY_RUN=0
REQUIRE_GREEN_CI=0
RECORD_WITHOUT_LIVE_SMOKE=0
usage() {
  echo "usage: infra/deploy.sh [--check | --dry-run] [--require-green-ci] [--record-without-live-smoke]" >&2
  exit 2
}
for arg in "$@"; do
  case "${arg}" in
    --check) CHECK_ONLY=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --require-green-ci) REQUIRE_GREEN_CI=1 ;;
    --record-without-live-smoke) RECORD_WITHOUT_LIVE_SMOKE=1 ;;
    *) usage ;;
  esac
done
if ((CHECK_ONLY && DRY_RUN)); then usage; fi

# --- Resolve paths and parameters --------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKOUT="$(cd "${SINNLOS_CHECKOUT:-${SCRIPT_DIR}/..}" && pwd)"
INFRA_DIR="${CHECKOUT}/infra"

COMPOSE_BASE="${INFRA_DIR}/docker-compose.yml"
COMPOSE_TRAEFIK="${INFRA_DIR}/docker-compose.traefik.yml"
# Rollback only: runs a pre-datetime-contract cms image in its old zone.
COMPOSE_LEGACY_TZ="${INFRA_DIR}/docker-compose.cms-legacy-tz.yml"
# Rollback only: runs a web image from before the web's datetime port
# (phase 2) in APP_TIME_ZONE again.
COMPOSE_WEB_LEGACY_TZ="${INFRA_DIR}/docker-compose.web-legacy-tz.yml"
BACKUP_SCRIPT="${INFRA_DIR}/backup/pg-backup.sh"
LIVE_SMOKE_SCRIPT="${INFRA_DIR}/live-smoke.sh"

# Compose project name — 'infra' on the owner's host, so container/image
# names are stable (infra-web-1, infra-cms-1, infra-db-1 / images infra-web,
# infra-cms). Another name (a staging project) gets its own containers,
# volumes, images, state and lock, but the backup dir, the smoke URL and
# the edge stay production's unless given: such a project needs SMOKE_URL
# and SINNLOS_BACKUP_DIR, and on a Docker host with containers of project
# infra an edge of its own (DEPLOY_SEPARATE_EDGE=1), or the deploy checks
# refuse it (step 0).
PROJECT="${COMPOSE_PROJECT:-infra}"
if ! [[ "${PROJECT}" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "ERROR: COMPOSE_PROJECT must be a compose project name (lower case, digits, - and _): ${PROJECT}" >&2
  exit 2
fi
COMPOSE=(docker compose -p "${PROJECT}" -f "${COMPOSE_BASE}" -f "${COMPOSE_TRAEFIK}")

# Whether the caller named the smoke URL (another project must).
SMOKE_URL_GIVEN="${SMOKE_URL:+1}"
SMOKE_URL="${SMOKE_URL:-https://sinnlos.yurtbay.dev}"
PASSWORDS_FILE="${PASSWORDS_FILE:-/home/bigemo/.sinnlos-env-backup/demo-account-passwords.txt}"
KEEP_TAGS="${DEPLOY_KEEP_TAGS:-5}"
if ! [[ "${KEEP_TAGS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: DEPLOY_KEEP_TAGS must be a whole number of at least 1: ${KEEP_TAGS}" >&2
  exit 2
fi

log() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

# --- 0. Preflight: env contract (FX13) --------------------------------------
# A live infra/.env from before FX13 can break this deploy in two ways, and
# both are caught here, before the backup and before any container changes:
#   - compose `${VAR:?}` keys that are empty: `up` would refuse to start;
#   - template placeholders in the cms secrets: the new cms image refuses to
#     boot with NODE_ENV=production (apps/cms/src/utils/env-guard.ts), but
#     only after `up -d --build` has replaced the running container, so the
#     site would be down until a rollback.
# The placeholder rule mirrors isPlaceholderSecret() in env-guard.ts (per
# comma-separated entry: a <...> stand-in or a change-me / changeme /
# toBeModified / generate-with-openssl / placeholder marker). AUTH_SECRET is
# scanned as well: the web has no boot guard of its own, and a placeholder
# there makes every session forgeable.
PREFLIGHT_FATAL_KEYS="APP_KEYS API_TOKEN_SALT ADMIN_JWT_SECRET TRANSFER_TOKEN_SALT JWT_SECRET ENCRYPTION_KEY REVALIDATE_SECRET INTERNAL_UPLOAD_TOKEN AUTH_SECRET"
PREFLIGHT_WARN_KEYS="DATABASE_PASSWORD"

# Reads `compose config --format json` on stdin (JSON, not YAML: the YAML
# rendering folds long values across lines) and prints key names only, never
# a value: "fatal KEY", "warn KEY", "digest KEY" (SMTP set, DIGESTS_DISABLED
# off, but the digest gate in apps/cms/src/digest/send-digests.ts would
# skip every run),
# "entra-invalid KEY" (ENTRA_ENABLED=1 and KEY fails the check the cms
# (apps/cms/src/entra/config.ts) or the web (apps/web/src/lib/auth-config.ts)
# runs at start, so both would refuse to start), "entra-was-on MS_CLIENT_ID"
# (without ENTRA_ENABLED=1, a real app registration: a GUID client id and a
# client secret, with which the running release may have offered Microsoft
# sign-in) or "entra-inert MS_CLIENT_ID" (other MS_* values left in
# infra/.env without ENTRA_ENABLED=1: ignored).
# The key lists, the markers, the digest rule and the Entra rules are
# pinned against env-guard.ts, send-digests.ts, entra/config.ts and the web's
# auth-config.ts by apps/cms/src/utils/deploy-preflight.test.ts.
preflight_scan() {
  awk -v fatal_keys="${PREFLIGHT_FATAL_KEYS}" -v warn_keys="${PREFLIGHT_WARN_KEYS}" '
    function placeholder(v,    n, i, parts, p) {
      n = split(tolower(v), parts, ",")
      for (i = 1; i <= n; i++) {
        p = parts[i]
        gsub(/^[ \t]+|[ \t]+$/, "", p)
        if (p == "") continue
        if (p ~ /^<.*>$/) return 1
        if (p ~ /change-me|changeme|tobemodified|generate-with-openssl|placeholder/) return 1
      }
      return 0
    }
    # 8-4-4-4-12 hex digits (no regex intervals: older mawk lacks them).
    function guid(v,    parts) {
      v = tolower(v)
      if (length(v) != 36 || v !~ /^[0-9a-f-]+$/ || split(v, parts, "-") != 5) return 0
      return length(parts[1]) == 8 && length(parts[2]) == 4 && length(parts[3]) == 4 && length(parts[4]) == 4 && length(parts[5]) == 12
    }
    function trim(v) {
      gsub(/^[ \t]+|[ \t]+$/, "", v)
      return v
    }
    # An on/off switch as the cms reads it (parseEnvFlag in
    # apps/cms/src/digest/send-digests.ts): 1, true, yes or on, any case,
    # blanks around ignored.
    function flag(v) {
      v = tolower(trim(v))
      return v == "1" || v == "true" || v == "yes" || v == "on"
    }
    # ENTRA_SESSION_TTL: <n>m, <n>h or <n>d, more than zero, at most 7d.
    function ttl_ok(v,    n, unit) {
      v = trim(v)
      if (v == "") return 1
      if (v !~ /^[0-9]+[mhd]$/) return 0
      unit = substr(v, length(v), 1)
      n = substr(v, 1, length(v) - 1) + 0
      n = n * (unit == "m" ? 60 : unit == "h" ? 3600 : 86400)
      return n > 0 && n <= 604800
    }
    # ENTRA_GROUP_ROLES: comma list of <roleType>:<groupGuid>, at most 20
    # distinct groups; blank entries are skipped.
    function group_roles_ok(v,    n, i, parts, e, c, role, g, seen, count) {
      n = split(v, parts, ",")
      count = 0
      for (i = 1; i <= n; i++) {
        e = trim(parts[i])
        if (e == "") continue
        c = index(e, ":")
        if (c == 0) return 0
        role = trim(substr(e, 1, c - 1))
        g = tolower(trim(substr(e, c + 1)))
        if (role !~ /^(admin_role|editor|department_head|team_lead|member|guest)$/) return 0
        if (!guid(g)) return 0
        if (!(g in seen)) { seen[g] = 1; count++ }
      }
      return count <= 20
    }
    BEGIN {
      n = split(fatal_keys, k, " "); for (i = 1; i <= n; i++) fatal[k[i]] = 1
      n = split(warn_keys, k, " "); for (i = 1; i <= n; i++) warn[k[i]] = 1
    }
    # Environment entries, one per line: "KEY": "value", (or null).
    /^[ \t]*"[A-Z][A-Z0-9_]*": / {
      line = $0; sub(/^[ \t]*"/, "", line)
      key = line; sub(/".*$/, "", key)
      val = line; sub(/^[A-Z0-9_]*":[ \t]*/, "", val); sub(/,[ \t]*$/, "", val)
      if (val == "null") val = ""
      else if (length(val) >= 2 && substr(val, 1, 1) == "\"" && substr(val, length(val), 1) == "\"")
        val = substr(val, 2, length(val) - 2)
      # Go JSON escapes < and > (so a <secret> stand-in arrives as <...>).
      gsub(/\\u003[cC]/, "<", val); gsub(/\\u003[eE]/, ">", val)
      env[key] = val
      if ((key in fatal) && placeholder(val)) print "fatal " key
      else if ((key in warn) && placeholder(val)) print "warn " key
    }
    END {
      if (!flag(env["DIGESTS_DISABLED"]) && env["SMTP_HOST"] != "" && env["SMTP_USER"] != "" && env["SMTP_PASS"] != "") {
        if (env["PUBLIC_WEB_URL"] ~ /^[ \t]*$/) print "digest PUBLIC_WEB_URL"
        if (env["DIGEST_FROM"] ~ /^[ \t]*$/) print "digest DIGEST_FROM"
      }
      # D-ENTRA-01: ENTRA_ENABLED is the only switch (exactly "1"). With it,
      # every value the cms and the web validate at start; the web gets
      # MS_CLIENT_SECRET as AUTH_MICROSOFT_ENTRA_ID_SECRET (compose).
      if (env["ENTRA_ENABLED"] == "1") {
        if (!guid(trim(env["MS_TENANT_ID"]))) print "entra-invalid MS_TENANT_ID"
        if (!guid(trim(env["MS_CLIENT_ID"]))) print "entra-invalid MS_CLIENT_ID"
        if (trim(env["AUTH_MICROSOFT_ENTRA_ID_SECRET"]) == "") print "entra-invalid MS_CLIENT_SECRET"
        if (length(trim(env["ENTRA_EXCHANGE_SECRET"])) < 32 || placeholder(env["ENTRA_EXCHANGE_SECRET"])) print "entra-invalid ENTRA_EXCHANGE_SECRET"
        mode = trim(env["ENTRA_SYNC_MODE"])
        if (mode != "" && mode != "on" && mode != "dry-run") print "entra-invalid ENTRA_SYNC_MODE"
        role = trim(env["ENTRA_DEFAULT_ROLE"])
        if (role != "" && role != "member" && role != "guest" && role != "deny") print "entra-invalid ENTRA_DEFAULT_ROLE"
        if (!ttl_ok(env["ENTRA_SESSION_TTL"])) print "entra-invalid ENTRA_SESSION_TTL"
        if (!group_roles_ok(env["ENTRA_GROUP_ROLES"])) print "entra-invalid ENTRA_GROUP_ROLES"
      } else if (guid(trim(env["AUTH_MICROSOFT_ENTRA_ID_ID"])) && trim(env["AUTH_MICROSOFT_ENTRA_ID_SECRET"]) != "") {
        # The web before D-ENTRA-01 offered Microsoft sign-in with exactly
        # these two keys; this deploy switches it off.
        print "entra-was-on MS_CLIENT_ID"
      } else if (env["MS_CLIENT_ID"] != "" || env["AUTH_MICROSOFT_ENTRA_ID_SECRET"] != "") {
        print "entra-inert MS_CLIENT_ID"
      }
    }' | sort -u
}

# D-SESSION-01: up to that change the web handed every signed-in user their
# own Strapi JWT on /api/auth/session. users-permissions JWTs are stateless
# (7 days, config/plugins.ts), so those copies stay valid until JWT_SECRET
# changes. A web image that keeps the JWT server-side says so with this label
# (apps/web/Dockerfile). A web container WITHOUT it — the first deploy of
# D-SESSION-01, or a roll-forward after rolling the web back to an older
# image — means the tokens were exposed, and the deploy needs a JWT_SECRET
# other than the one the running cms signs with.
JWT_OFF_SESSION_LABEL="org.sinnlos.strapi-jwt"
JWT_OFF_SESSION_VALUE="server-only"

# Prints one environment value from `compose config --format json` on stdin
# (first match). Only ever captured into a variable, never echoed.
compose_env_value() {
  awk -v want="$1" '
    /^[ \t]*"[A-Z][A-Z0-9_]*": / {
      line = $0; sub(/^[ \t]*"/, "", line)
      key = line; sub(/".*$/, "", key)
      if (key != want) next
      val = line; sub(/^[A-Z0-9_]*":[ \t]*/, "", val); sub(/,[ \t]*$/, "", val)
      if (val == "null") val = ""
      else if (length(val) >= 2 && substr(val, 1, 1) == "\"" && substr(val, length(val), 1) == "\"")
        val = substr(val, 2, length(val) - 2)
      # Go JSON escapes <, > and &. An escape left over here can only make
      # two equal secrets look different (no gate), never the reverse.
      gsub(/\\u003[cC]/, "<", val); gsub(/\\u003[eE]/, ">", val); gsub(/\\u0026/, "\\&", val)
      print val
      exit
    }'
}

# True (0) when the running web predates D-SESSION-01 and the JWT_SECRET about
# to be deployed equals the running cms's. No running web or cms (first
# install) = nothing was exposed = false.
jwt_rotation_missing() {
  local label running_secret new_secret
  label="$(docker inspect --format "{{ index .Config.Labels \"${JWT_OFF_SESSION_LABEL}\" }}" \
    "${PROJECT}-web-1" 2>/dev/null)" || return 1
  [[ "${label}" != "${JWT_OFF_SESSION_VALUE}" ]] || return 1
  running_secret="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
    "${PROJECT}-cms-1" 2>/dev/null | sed -n 's/^JWT_SECRET=//p' | head -n 1)" || return 1
  [[ -n "${running_secret}" ]] || return 1
  new_secret="$("${COMPOSE[@]}" config --format json 2>/dev/null | compose_env_value JWT_SECRET)"
  [[ "${new_secret}" == "${running_secret}" ]]
}

# Datetime contract: the first boot of a cms with it repairs the times a
# pre-contract cms stored as naive wall clocks and converts the columns to
# timestamptz (apps/cms/database/migrations/). With naive app columns in the
# running database and DATETIME_LEGACY_ZONE unset it refuses to start, so
# the deploy is refused here, before the backup and before any container
# changes. No running db container (first install) = nothing to repair.
# Strapi's bookkeeping tables do not count (the cms guard converts them).
# Prints the number of naive timestamp columns of the running database's
# app tables (bookkeeping excluded), or nothing when there is no db
# container to ask or the query gave up (after 5 s waiting for a lock, 10 s
# in all). Arguments run in front of the docker call: the rollback hint
# passes PROBE_TIMEOUT.
naive_app_columns() {
  # $POSTGRES_USER / $POSTGRES_DB expand in the db container's sh (shellcheck
  # no longer sees the docker exec behind the "$@" prefix).
  # shellcheck disable=SC2016
  "$@" docker exec -i "${PROJECT}-db-1" sh -c 'psql -X -q -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>/dev/null <<'SQL'
SET lock_timeout = '5s';
SET statement_timeout = '10s';
SELECT count(*) FROM information_schema.columns
 WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'
   AND table_name NOT IN ('strapi_migrations', 'strapi_migrations_internal', 'strapi_database_schema');
SQL
}

datetime_repair_env_missing() {
  local zone naive
  zone="$("${COMPOSE[@]}" config --format json 2>/dev/null | compose_env_value DATETIME_LEGACY_ZONE)"
  [[ -z "${zone}" ]] || return 1
  naive="$(naive_app_columns)" || return 1
  [[ "${naive}" =~ ^[0-9]+$ && "${naive}" -gt 0 ]]
}

# The rollback hint runs on a failed deploy and must print every line, also
# with a hung docker daemon or a locked database: each of its docker calls
# runs under this bound. `timeout` exits 124 at the deadline (137 after the
# kill) and 127 when it is missing; the hint then treats what that call
# would have told as unknown and prints the safe variant.
PROBE_TIMEOUT=(timeout -k 5 15)

# Datetime phase 2: a web image that renders every date in APP_TIME_ZONE by
# itself runs in UTC and says so with this label (apps/web/Dockerfile). An
# older web image renders in its process zone: under compose's TZ=UTC it
# refuses to start (from the datetime release on) or quietly shows UTC
# times (before it); it runs only with COMPOSE_WEB_LEGACY_TZ on top.
WEB_DATETIME_LABEL="org.sinnlos.datetime"
WEB_DATETIME_VALUE="zone-explicit"

# Whether a web image renders in APP_TIME_ZONE by itself (the label): exit 0
# yes, 1 no (it predates the web's datetime port), anything else unknown (no
# such image here, docker failed or timed out, no `timeout`). Never pulls.
image_web_zone_explicit() {
  local label
  label="$("${PROBE_TIMEOUT[@]}" docker image inspect -f "{{ index .Config.Labels \"${WEB_DATETIME_LABEL}\" }}" "$1" 2>/dev/null)" || return 2
  [[ "${label}" == "${WEB_DATETIME_VALUE}" ]]
}

# Whether a cms image knows poll guest access (its poll schema has
# visibleToGuests): exit 0 yes, 1 no, anything else unknown (no such image
# here, another layout, docker failed or timed out, no `timeout`). Never
# pulls, no network.
POLL_SCHEMA_IN_IMAGE="/app/apps/cms/src/api/poll/content-types/poll/schema.json"
image_has_poll_guest_access() {
  "${PROBE_TIMEOUT[@]}" docker run --rm --pull never --network none --entrypoint grep "$1" \
    -q visibleToGuests "${POLL_SCHEMA_IN_IMAGE}" 2>/dev/null
}

# Poll guest access: the first boot of that release grants the guest role
# api::poll-vote.poll-vote.vote. A cms from before it (on the owner
# instance the :rollback image of that deploy) ignores the per-poll guest
# switches and the department targeting and never removes that row, so
# there every guest can vote on every open poll. What the database holds
# at the time decides nothing: a new cms that missed compose's health
# deadline before its bootstrap granted the row keeps starting (or
# restarts) and grants it afterwards. So every rollback to such a cms, or to one that cannot be
# checked, stops the cms, removes the row, retags, starts, and removes it
# again (docs/DEPLOYMENT.md, "Upgrading to poll department targeting",
# Rollback). Only a target cms that knows guest access goes without: the
# row is then its own grant. ($POSTGRES_USER / $POSTGRES_DB expand in the
# db container's sh.)
# shellcheck disable=SC2016
REVOKE_GUEST_VOTE_PSQL='psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

# Before the retag commands: stop the cms, then remove the row. $1 is the
# exit code of image_has_poll_guest_access for the target cms image $2 (not
# 0).
print_guest_vote_revoke_hint() {
  local image="$2"
  if [[ "$1" == "1" ]]; then
    echo "       FIRST, before the retag: ${image} predates poll guest access." >&2
  else
    echo "       FIRST, before the retag, unless ${image} knows poll guest access (it could not be" >&2
    echo "       checked here: skip the removal and its rerun below only if this prints 1 or more):" >&2
    echo "                      docker run --rm --pull never --network none --entrypoint grep ${image} -c visibleToGuests ${POLL_SCHEMA_IN_IMAGE}" >&2
  fi
  echo "       A cms from before poll guest access ignores the guest switches and the department targeting" >&2
  echo "       of polls and never removes the guest poll-vote permission this release grants: while it" >&2
  echo "       exists, every guest can vote on every open poll there. Stop the cms, then remove the" >&2
  echo "       permission, also when the database or the admin panel shows none (a new cms that is" >&2
  echo "       still starting or restarting grants it afterwards):" >&2
  echo "                      ${COMPOSE[*]} stop cms" >&2
  echo "                      ${COMPOSE[*]} exec -T db sh -c '${REVOKE_GUEST_VOTE_PSQL}' < ${INFRA_DIR}/rollback/revoke-guest-poll-vote.sql" >&2
}

# After the start commands: the same removal once more, which must find
# nothing.
print_guest_vote_recheck_hint() {
  echo "       THEN, once the previous cms is up, run the removal again. It must remove nothing" >&2
  echo "       (guest_links_removed 0, permission_rows_removed 0); anything else means a new cms had" >&2
  echo "       granted the permission again in between, and the rerun removed it:" >&2
  echo "                      ${COMPOSE[*]} exec -T db sh -c '${REVOKE_GUEST_VOTE_PSQL}' < ${INFRA_DIR}/rollback/revoke-guest-poll-vote.sql" >&2
  echo "       (docs/DEPLOYMENT.md, \"Upgrading to poll department targeting\", Rollback)." >&2
}

# The rollback target of this deploy (step 2): the images
# <project>-{web,cms}:<ROLLBACK_REF>. ROLLBACK_REF is the SHA tag of the
# last-known-good deploy from the state file, or "rollback" when this run
# tagged the running images (no usable state yet), or empty when there is
# nothing to go back to (a fresh install). ROLLBACK_ORIGIN says which.
ROLLBACK_REF=""
ROLLBACK_ORIGIN=""

# The rollback commands for a failed deploy, for the target above. While the
# datetime repair has not run (naive app columns left), the previous cms
# image predates the datetime contract and must run in its old zone, never
# in the UTC this compose file sets (docs/DEPLOYMENT.md, "Rolling back this
# release"). A cms image from before the ICS and cms start fixes starts with
# `pnpm start` and downloads pnpm at every start. Its Cmd tells, not its
# build date: the :rollback image of that release's first deploy was built
# on the same day as the fix. A target cms from before poll guest access, or
# one that cannot be checked, gets the guest vote row removed before the
# retag and once more after the start (print_guest_vote_revoke_hint).
# A target web from before the web's datetime port, or one that cannot be
# checked, gets the web legacy-zone override: that web must run in
# APP_TIME_ZONE (in UTC it refuses to start, or, before the datetime
# release, quietly shows UTC times), and the override is harmless for a
# newer one (it only warns).
# Every probe is bounded (PROBE_TIMEOUT); one that fails or times out
# prints the variant for the unknown case, never fewer lines.
print_rollback_hint() {
  if [[ -z "${ROLLBACK_REF}" ]]; then
    echo "       There is no earlier release on this host to roll back to (no last-known-good state and" >&2
    echo "       no containers ran before this deploy): fix the cause and re-run." >&2
    return 0
  fi
  local rollback=("${COMPOSE[@]}") naive cms_cmd guest_access=0 web_zone=0
  local web_image="${PROJECT}-web:${ROLLBACK_REF}" cms_image="${PROJECT}-cms:${ROLLBACK_REF}"
  naive="$(naive_app_columns "${PROBE_TIMEOUT[@]}" || true)"
  cms_cmd="$("${PROBE_TIMEOUT[@]}" docker image inspect -f '{{json .Config.Cmd}}' "${cms_image}" 2>/dev/null || true)"
  image_has_poll_guest_access "${cms_image}" || guest_access=$?
  image_web_zone_explicit "${web_image}" || web_zone=$?
  if [[ "${guest_access}" != "0" ]]; then
    print_guest_vote_revoke_hint "${guest_access}" "${cms_image}"
  fi
  echo "       To roll back to ${ROLLBACK_ORIGIN:-${web_image} and ${cms_image}}, retag, then start without a build:" >&2
  echo "                      docker tag ${web_image} ${PROJECT}-web:latest" >&2
  echo "                      docker tag ${cms_image} ${PROJECT}-cms:latest" >&2
  if [[ "${naive}" =~ ^[0-9]+$ && "${naive}" -gt 0 ]]; then
    rollback+=(-f "${COMPOSE_LEGACY_TZ}")
    echo "       (the datetime repair has NOT run: the previous cms must run in DATETIME_LEGACY_ZONE," >&2
    echo "       hence the extra override file)" >&2
  elif ! [[ "${naive}" =~ ^[0-9]+$ ]]; then
    echo "       (the database could not be asked whether the datetime repair has run; if it has not, the" >&2
    echo "       previous cms must run in DATETIME_LEGACY_ZONE: add -f ${COMPOSE_LEGACY_TZ} before up," >&2
    echo "       docs/DEPLOYMENT.md, \"Rolling back this release\")" >&2
  fi
  if [[ "${web_zone}" != "0" ]]; then
    rollback+=(-f "${COMPOSE_WEB_LEGACY_TZ}")
    if [[ "${web_zone}" == "1" ]]; then
      echo "       (${web_image} predates the web's datetime port: it renders dates in its process" >&2
      echo "       zone, so in UTC it fails to start or shows UTC times; hence the web override, which runs it in APP_TIME_ZONE)" >&2
    else
      echo "       (${web_image} could not be checked for the web's datetime port, so the web" >&2
      echo "       override is included: in UTC a web from before it fails to start or shows UTC times, a newer one only" >&2
      echo "       warns. Check: docker image inspect -f '{{ index .Config.Labels \"${WEB_DATETIME_LABEL}\" }}' ${web_image}" >&2
      echo "       prints ${WEB_DATETIME_VALUE} for a web that needs no override)" >&2
    fi
  fi
  echo "                      ${rollback[*]} up -d --no-build web cms" >&2
  echo "       (--no-build is essential — --build would rebuild the broken image)" >&2
  if [[ "${cms_cmd}" == *'"pnpm"'* ]]; then
    echo "       ${cms_image} starts with pnpm (Cmd ${cms_cmd}) and downloads pnpm from" >&2
    echo "       registry.npmjs.org at every start. Without registry access, start it directly instead:" >&2
    # printf '%s\n': the \n of the printed command stay literal.
    printf '%s\n' "                      printf 'services:\\n  cms:\\n    command: [\"node_modules/.bin/strapi\", \"start\"]\\n' > /tmp/cms-direct-start.yml" >&2
    echo "                      ${rollback[*]} -f /tmp/cms-direct-start.yml up -d --no-build web cms" >&2
    echo "       (docs/DEPLOYMENT.md, \"Upgrading to the ICS and cms start fixes (2026-09-27)\", Rollback)." >&2
  elif [[ -z "${cms_cmd}" ]]; then
    echo "       A cms image from before the ICS and cms start fixes starts with pnpm (Cmd [\"pnpm\",\"start\"])" >&2
    echo "       and downloads pnpm from registry.npmjs.org at every start. Check the rollback image:" >&2
    echo "                      docker image inspect -f '{{json .Config.Cmd}}' ${cms_image}" >&2
    echo "       Without registry access, start it directly (docs/DEPLOYMENT.md, \"Upgrading to the ICS" >&2
    echo "       and cms start fixes (2026-09-27)\", Rollback)." >&2
  fi
  if [[ "${guest_access}" != "0" ]]; then
    print_guest_vote_recheck_hint
  fi
  if [[ "${ROLLBACK_REF}" == "rollback" ]]; then
    echo "       Rollback target: :rollback, the images that ran before the first deploy with this script (no" >&2
    echo "       last-known-good state yet); a re-run before the first successful deploy keeps this :rollback" >&2
    echo "       (${BOOTSTRAP_FILE}, docs/DEPLOYMENT.md §7.4)." >&2
  else
    echo "       Rollback target: the last-known-good state (${STATE_FILE}); a re-run of this" >&2
    echo "       script keeps it until a deploy passes the smoke check and live-smoke (docs/DEPLOYMENT.md §7.4)." >&2
  fi
}

# --- Last-known-good state (FX35) --------------------------------------------
# Written only after the smoke check and live-smoke passed: the commit, its
# SHA tag and the image ids web and cms ran with. A plain key=value file,
# read back by key (never sourced). Kept in the checkout's git dir by
# default: outside the working tree, never committed, the same for every
# user that runs this script on the host.
STATE_KEYS="SHA TAG DEPLOYED_AT WEB_IMAGE CMS_IMAGE LIVE_SMOKE"

# Reads STATE_FILE into STATE_<KEY>; false without a usable state (no file,
# or a TAG that is not a 12-digit hex SHA prefix).
read_state() {
  local key value
  for key in ${STATE_KEYS}; do printf -v "STATE_${key}" '%s' ""; done
  [[ -r "${STATE_FILE}" ]] || return 1
  while IFS='=' read -r key value; do
    case " ${STATE_KEYS} " in
      *" ${key} "*) printf -v "STATE_${key}" '%s' "${value}" ;;
    esac
  done < "${STATE_FILE}"
  [[ "${STATE_TAG}" =~ ^[0-9a-f]{12}$ ]]
}

# Before the first recorded deploy: the run that tagged :rollback (step 2
# without a state) writes BOOTSTRAP_FILE with the image ids of both
# :rollback tags; step 5 deletes it once the state is written. While it
# exists and both :rollback tags still name those ids, a later run without
# a state keeps them instead of tagging whatever runs then (after a failed
# first deploy that is the failed images). Read by key, never sourced.
BOOTSTRAP_KEYS="WEB_IMAGE CMS_IMAGE TAGGED_AT"

# True (0) when BOOTSTRAP_FILE names the ids both :rollback tags still have
# (BOOT_<KEY> set from it).
bootstrap_rollback_intact() {
  local key value
  for key in ${BOOTSTRAP_KEYS}; do printf -v "BOOT_${key}" '%s' ""; done
  [[ -r "${BOOTSTRAP_FILE}" ]] || return 1
  while IFS='=' read -r key value; do
    case " ${BOOTSTRAP_KEYS} " in
      *" ${key} "*) printf -v "BOOT_${key}" '%s' "${value}" ;;
    esac
  done < "${BOOTSTRAP_FILE}"
  [[ -n "${BOOT_WEB_IMAGE}" && -n "${BOOT_CMS_IMAGE}" ]] || return 1
  [[ "$(docker image inspect -f '{{.Id}}' "${PROJECT}-web:rollback" 2>/dev/null)" == "${BOOT_WEB_IMAGE}" ]] &&
    [[ "$(docker image inspect -f '{{.Id}}' "${PROJECT}-cms:rollback" 2>/dev/null)" == "${BOOT_CMS_IMAGE}" ]]
}

# Writes BOOTSTRAP_FILE for the :rollback tags this run set; a failure only
# warns (a later run then tags what runs, as before).
write_bootstrap() {
  local web_id cms_id tmp="${BOOTSTRAP_FILE}.tmp.$$"
  if web_id="$(docker image inspect -f '{{.Id}}' "${PROJECT}-web:rollback" 2>/dev/null)" &&
    cms_id="$(docker image inspect -f '{{.Id}}' "${PROJECT}-cms:rollback" 2>/dev/null)" &&
    {
      echo "# infra/deploy.sh: the :rollback images of compose project ${PROJECT} before its first recorded"
      echo "# deploy; kept by later runs until a deploy is recorded (then deleted; do not edit)"
      echo "WEB_IMAGE=${web_id}"
      echo "CMS_IMAGE=${cms_id}"
      echo "TAGGED_AT=$(date -Is)"
    } > "${tmp}" && own_like_git_dir "${tmp}" && mv -f "${tmp}" "${BOOTSTRAP_FILE}"; then
    echo "  kept in ${BOOTSTRAP_FILE} until the first deploy is recorded"
  else
    rm -f "${tmp}" 2>/dev/null || true
    echo "  WARNING: could not write ${BOOTSTRAP_FILE}; a re-run before a recorded deploy tags what runs then." >&2
  fi
}

# A file this script creates in the state dir as root gets the owner of the
# git dir, so the checkout's owner can deploy (and write it) next time.
own_like_git_dir() {
  if ((EUID == 0)); then
    chown --reference="${GIT_DIR}" "$@" 2>/dev/null || true
  fi
}

# Step 2. Sets ROLLBACK_REF/ROLLBACK_ORIGIN; tags the running images
# :rollback only without a usable state (and only for a real deploy).
resolve_rollback_target() {
  local svc container img tagged=0
  if read_state && docker image inspect "${PROJECT}-web:${STATE_TAG}" >/dev/null 2>&1 &&
    docker image inspect "${PROJECT}-cms:${STATE_TAG}" >/dev/null 2>&1; then
    ROLLBACK_REF="${STATE_TAG}"
    ROLLBACK_ORIGIN="the last-known-good deploy ${STATE_TAG} (${STATE_DEPLOYED_AT})"
    echo "  last-known-good: ${PROJECT}-{web,cms}:${STATE_TAG} (commit ${STATE_SHA}, deployed ${STATE_DEPLOYED_AT})"
    for svc in web cms; do
      img="$(docker inspect --format '{{.Image}}' "${PROJECT}-${svc}-1" 2>/dev/null || true)"
      local want="STATE_${svc^^}_IMAGE"
      if [[ -n "${img}" && "${img}" != "${!want}" ]]; then
        echo "  NOTE: ${PROJECT}-${svc}-1 does not run the last-known-good image; a rollback goes to"
        echo "        ${PROJECT}-${svc}:${STATE_TAG}, not to what runs now."
      fi
    done
    return 0
  fi
  if [[ -e "${STATE_FILE}" ]]; then
    echo "  WARNING: ${STATE_FILE} names no usable last-known-good images (tag ${STATE_TAG:-?} missing here)."
  fi
  # First run with the state-keeping deploy.sh (or its images are gone):
  # today's :rollback tags. Re-upping MUST use --no-build: with --build
  # compose would rebuild (and re-deploy) the broken image instead of
  # starting the retagged one. A run before this one that set them, with
  # no deploy recorded since, keeps them (BOOTSTRAP_FILE).
  if bootstrap_rollback_intact; then
    ROLLBACK_REF="rollback"
    ROLLBACK_ORIGIN="the images that ran before the first deploy with this script (:rollback, tagged ${BOOT_TAGGED_AT})"
    echo "  :rollback kept from ${BOOT_TAGGED_AT} (no deploy recorded since, ${BOOTSTRAP_FILE}):"
    echo "  ${PROJECT}-web:rollback = ${BOOT_WEB_IMAGE}, ${PROJECT}-cms:rollback = ${BOOT_CMS_IMAGE}"
    return 0
  fi
  if [[ -e "${BOOTSTRAP_FILE}" ]]; then
    echo "  NOTE: the :rollback tags no longer name the images in ${BOOTSTRAP_FILE}; tagging what runs now."
  fi
  for svc in web cms; do
    container="${PROJECT}-${svc}-1"
    if img="$(docker inspect --format '{{.Image}}' "${container}" 2>/dev/null)" && [[ -n "${img}" ]]; then
      if ((DRY_RUN)); then
        echo "  would tag ${container} (${img}) as ${PROJECT}-${svc}:rollback"
      elif ! docker tag "${img}" "${PROJECT}-${svc}:rollback"; then
        echo "  ${container} runs ${img}, which cannot be resolved here any more (no tag references it):"
        echo "  nothing to roll back to for ${svc}"
        continue
      else
        echo "  ${container} (${img}) -> ${PROJECT}-${svc}:rollback"
      fi
      tagged=$((tagged + 1))
    else
      echo "  ${container} not running — nothing to roll back to for ${svc}"
    fi
  done
  if ((tagged == 2)); then
    ROLLBACK_REF="rollback"
    ROLLBACK_ORIGIN="the images that ran before this deploy (:rollback)"
  elif ((tagged == 1)) && docker image inspect "${PROJECT}-web:rollback" >/dev/null 2>&1 &&
    docker image inspect "${PROJECT}-cms:rollback" >/dev/null 2>&1; then
    ROLLBACK_REF="rollback"
    ROLLBACK_ORIGIN=":rollback (only one of web and cms ran before this deploy)"
  fi
  if [[ "${ROLLBACK_REF}" == "rollback" ]] && ! ((DRY_RUN)); then
    write_bootstrap
  fi
}

# Step 2, on every run: the images web and cms run now also get the tag
# <project>-<svc>:pre-deploy, which each run moves; it is never a rollback
# target and never pruned. On the containerd image store (docker info:
# driver-type io.containerd.snapshotter.v1) an image that no tag references
# can no longer be resolved by its id. After a deploy that failed after
# `up`, only :latest references the running images; the next run's build
# moves :latest, compose keeps a container whose content did not change,
# and step 5 could not tag what it runs. A tag that cannot be set only
# warns (step 5 then says whether it matters).
keep_running_images() {
  local svc container img
  for svc in web cms; do
    container="${PROJECT}-${svc}-1"
    img="$(docker inspect --format '{{.Image}}' "${container}" 2>/dev/null)" && [[ -n "${img}" ]] || continue
    if ((DRY_RUN)); then
      echo "  would tag ${container} (${img}) as ${PROJECT}-${svc}:pre-deploy (keeps it resolvable through the build)"
    elif docker tag "${img}" "${PROJECT}-${svc}:pre-deploy"; then
      echo "  ${container} (${img}) -> ${PROJECT}-${svc}:pre-deploy (keeps it resolvable through the build)"
    else
      echo "WARNING: could not tag ${img} (${container}) as ${PROJECT}-${svc}:pre-deploy; it cannot be resolved here any more." >&2
    fi
  done
}

# Step 5: tag what web and cms run now as :<NEW_TAG> and record it. Both
# images must resolve before either tag moves (never a new web tag next to
# an old cms one). A failed tag is a failed deploy (the ERR trap prints the
# rollback); a state that cannot be written only warns: the previous
# last-known-good stays valid, and RECORDED=0 keeps the prune from removing
# its tags.
record_last_known_good() {
  local web_id cms_id tmp id
  web_id="$(docker inspect --format '{{.Image}}' "${PROJECT}-web-1")"
  cms_id="$(docker inspect --format '{{.Image}}' "${PROJECT}-cms-1")"
  for id in "${web_id}" "${cms_id}"; do
    if ! docker image inspect "${id}" >/dev/null 2>&1; then
      echo "ERROR: the image ${id} that ${PROJECT}-web-1 or ${PROJECT}-cms-1 runs cannot be resolved here any more" >&2
      echo "       (no tag references it), so it cannot be tagged ${NEW_TAG}. Nothing was tagged. Recreate the" >&2
      echo "       containers from the current images, then re-run this script:" >&2
      echo "                      ${COMPOSE[*]} up -d --no-build --force-recreate web cms" >&2
      return 1
    fi
  done
  docker tag "${web_id}" "${PROJECT}-web:${NEW_TAG}"
  docker tag "${cms_id}" "${PROJECT}-cms:${NEW_TAG}"
  echo "  ${PROJECT}-web:${NEW_TAG} = ${web_id}"
  echo "  ${PROJECT}-cms:${NEW_TAG} = ${cms_id}"
  # The history lists every SHA tag this script set, for the prune, also
  # when the state below cannot be written.
  if ! {
    { [[ -e "${HISTORY_FILE}" ]] || { : > "${HISTORY_FILE}" && own_like_git_dir "${HISTORY_FILE}"; }; } &&
      echo "${NEW_TAG} ${HEAD_SHA} $(date -Is)" >> "${HISTORY_FILE}"
  }; then
    echo "WARNING: could not append to ${HISTORY_FILE}: ${NEW_TAG} is never pruned automatically." >&2
  fi
  if ! {
    tmp="${STATE_FILE}.tmp.$$" &&
      {
        echo "# infra/deploy.sh: last-known-good deploy of compose project ${PROJECT}"
        echo "# (written after the smoke check and live-smoke passed; do not edit)"
        echo "SHA=${HEAD_SHA}"
        echo "TAG=${NEW_TAG}"
        echo "DEPLOYED_AT=$(date -Is)"
        echo "WEB_IMAGE=${web_id}"
        echo "CMS_IMAGE=${cms_id}"
        echo "LIVE_SMOKE=${LIVE_SMOKE_RESULT}"
      } > "${tmp}" && own_like_git_dir "${tmp}" && mv -f "${tmp}" "${STATE_FILE}"
  }; then
    rm -f "${tmp:-}" 2>/dev/null || true
    echo "WARNING: could not write ${STATE_FILE}: the last-known-good state still names the previous deploy." >&2
    RECORDED=0
    return 0
  fi
  RECORDED=1
  echo "  recorded in ${STATE_FILE}"
  # From now on the state is the rollback target; :rollback is no longer kept.
  rm -f "${BOOTSTRAP_FILE}" 2>/dev/null || true
}

# SHA tags this script created (the history file), newest last, each once.
history_tags() {
  [[ -r "${HISTORY_FILE}" ]] || return 0
  awk '$1 ~ /^[0-9a-f]+$/ && length($1) == 12 { last[$1] = NR; order[NR] = $1 }
    END { for (i = 1; i <= NR; i++) if (order[i] != "" && last[order[i]] == i) print order[i] }' "${HISTORY_FILE}"
}

# Prints the SHA tags beyond the newest KEEP_TAGS, given the tag that is
# (or is about to become) the newest.
tags_to_prune() {
  local newest="$1"
  { history_tags | grep -vx "${newest}" || true; echo "${newest}"; } |
    head -n "-${KEEP_TAGS}"
}

# Removes <project>-{web,cms}:<tag> of every tag beyond the newest
# KEEP_TAGS, then drops them from the history. Only tags this script
# created, never the one the state file names (the rollback target), which
# stays in the history too; never fails the deploy. Runs only after the
# state was written (RECORDED).
prune_sha_tags() {
  local tag keep protected
  protected="$(sed -n 's/^TAG=//p' "${STATE_FILE}" 2>/dev/null || true)"
  protected="${protected%%$'\n'*}"
  while IFS= read -r tag; do
    [[ -n "${tag}" && "${tag}" != "${NEW_TAG}" && "${tag}" != "${protected}" ]] || continue
    if docker image rm "${PROJECT}-web:${tag}" "${PROJECT}-cms:${tag}" >/dev/null 2>&1; then
      echo "  pruned ${PROJECT}-{web,cms}:${tag}"
    else
      echo "  could not remove every image of ${tag} (in use or already gone); dropped from the history"
    fi
  done < <(tags_to_prune "${NEW_TAG}")
  keep="$(history_tags | tail -n "${KEEP_TAGS}")"
  if [[ -n "${protected}" ]]; then keep+=$'\n'"${protected}"; fi
  if [[ -w "${HISTORY_FILE}" ]]; then
    awk 'NR == FNR { keep[$1] = 1; next } ($1 in keep)' <(printf '%s\n' "${keep}") "${HISTORY_FILE}" \
      > "${HISTORY_FILE}.tmp.$$" && cat "${HISTORY_FILE}.tmp.$$" > "${HISTORY_FILE}"
    rm -f "${HISTORY_FILE}.tmp.$$"
  fi
}

# --- CI status of the commit (FX35) ------------------------------------------
# GitHub's check runs for HEAD, read without gh or jq. Prints one of: green,
# pending, failed, unknown — followed by a reason. Never fails.
ci_status() {
  local remote slug body total
  remote="$("${GIT[@]}" remote get-url origin 2>/dev/null || true)"
  if ! [[ "${remote}" =~ github\.com[:/]([^/]+/[^/]+)$ ]]; then
    echo "unknown: the origin remote is not on github.com"
    return 0
  fi
  slug="${BASH_REMATCH[1]%.git}"
  # The token (if any) goes to curl on stdin, never on its command line.
  if ! body="$(
    {
      if [[ -n "${GITHUB_TOKEN:-}" ]]; then printf 'header = "Authorization: Bearer %s"\n' "${GITHUB_TOKEN}"; fi
    } | curl -sS -f --max-time 10 --config - -H 'Accept: application/vnd.github+json' \
      "https://api.github.com/repos/${slug}/commits/${HEAD_SHA}/check-runs?per_page=100" 2>&1
  )"; then
    echo "unknown: no usable answer from the GitHub API (${body##*: })"
    return 0
  fi
  total="$(grep -oE '"total_count": *[0-9]+' <<<"${body}" | grep -oE '[0-9]+$' | head -n 1)"
  if [[ -z "${total}" || "${total}" == "0" ]]; then
    echo "unknown: no CI run for ${HEAD_SHA:0:12} on ${slug} (not pushed yet, or CI has not started)"
  elif grep -qE '"status": *"(queued|in_progress|waiting|requested|pending)"' <<<"${body}"; then
    echo "pending: CI is still running for ${HEAD_SHA:0:12}"
  elif grep -qE '"conclusion": *"(failure|cancelled|timed_out|action_required|startup_failure|stale)"' <<<"${body}"; then
    echo "failed: CI did not pass for ${HEAD_SHA:0:12} (https://github.com/${slug}/commit/${HEAD_SHA}/checks)"
  else
    echo "green: ${total} CI check(s) passed for ${HEAD_SHA:0:12}"
  fi
}

# --- ERR trap ------------------------------------------------------------------
# Every failure the script does not handle itself ends here: before the
# stack was touched nothing needs undoing; from "start" on the rollback
# commands follow. Main shell only (command substitutions inherit the trap).
PHASE="preflight"
on_err() {
  local rc="$1" line="$2"
  [[ "${BASHPID}" == "$$" ]] || return 0
  trap - ERR
  echo "ERROR: infra/deploy.sh failed during '${PHASE}' (line ${line}, exit ${rc})." >&2
  case "${PHASE}" in
    preflight | checks | backup | rollback-target | build)
      echo "       The running containers are untouched. Fix the cause and re-run." >&2
      ;;
    *)
      echo "       The stack may already run the new images. Inspect logs:  ${COMPOSE[*]} logs --tail=100 web cms" >&2
      echo "       Fix the cause and re-run, or roll back:" >&2
      print_rollback_hint
      ;;
  esac
}
trap 'on_err "$?" "${LINENO}"' ERR

log "Preflight: infra/.env against the env contract (FX13)"
if ! "${COMPOSE[@]}" config -q; then
  echo "ERROR: docker compose rejected the config — most likely a required key in" >&2
  echo "       infra/.env is missing or empty (named above). Nothing was changed." >&2
  echo "       Fill it in (infra/.env.example has the generation hints) and re-run." >&2
  exit 1
fi
findings="$("${COMPOSE[@]}" config --format json 2>/dev/null | preflight_scan)"
keys_of() { sed -n "s/^$1 //p" <<<"${findings}" | tr '\n' ' '; }
fatal_keys="$(keys_of fatal)"
warn_keys="$(keys_of warn)"
digest_keys="$(keys_of digest)"
entra_invalid_keys="$(keys_of entra-invalid)"
entra_inert_keys="$(keys_of entra-inert)"
entra_was_on_keys="$(keys_of entra-was-on)"
# Not fatal: the owner instance may keep an unused registration in
# infra/.env. But an instance that still signs users in with the old
# Microsoft flow loses it with this deploy.
if [[ -n "${entra_was_on_keys}" ]]; then
  echo "WARNING: infra/.env holds a Microsoft app registration (MS_CLIENT_ID is a GUID and" >&2
  echo "         MS_CLIENT_SECRET is set), but ENTRA_ENABLED is not 1. If Microsoft sign-in" >&2
  echo "         works with the running release, it is OFF after this deploy (local sign-in is" >&2
  echo "         on) until ENTRA_ENABLED=1 is set. Accounts the old flow created have no password," >&2
  echo "         and the new sign-in answers \"already exists\" for them until an admin binds each" >&2
  echo "         one: docs/DEPLOYMENT.md, \"Upgrading to the Entra sign-in (batch 9, lane 4A)\"." >&2
  echo "         Nothing to do if Microsoft sign-in was never used here." >&2
fi
if [[ -n "${entra_inert_keys}" ]]; then
  echo "NOTE: MS_CLIENT_ID/MS_CLIENT_SECRET are set in infra/.env, but ENTRA_ENABLED is not 1:" >&2
  echo "      Microsoft sign-in stays off and the MS_* values are ignored (safe to delete)." >&2
fi
if [[ -n "${warn_keys}" ]]; then
  echo "WARNING: template placeholder in: ${warn_keys}" >&2
  echo "         Rotate it (ALTER ROLE ... PASSWORD in Postgres first, then infra/.env);" >&2
  echo "         the cms only warns about it." >&2
fi
preflight_failed=0
if [[ -n "${digest_keys}" ]]; then
  # Fatal since the final review (C4): FX13 removed the compose sender default,
  # so an env that relied on it would silently lose every digest (and Strapi's
  # own mails their default sender) — also on a cms rollback under this
  # compose file, which now hands the old image an empty DIGEST_FROM.
  echo "ERROR: SMTP_* is set but these are empty: ${digest_keys}" >&2
  echo "       Every e-mail digest run would be skipped (FX13 removed the built-in sender" >&2
  echo "       and link defaults). Set them in infra/.env, e.g." >&2
  echo "       DIGEST_FROM='Intranet <noreply@your-domain>', or set DIGESTS_DISABLED=1." >&2
  preflight_failed=1
fi
if [[ -n "${fatal_keys}" ]]; then
  echo "ERROR: template placeholder in: ${fatal_keys}" >&2
  echo "       The cms refuses to start in production with a placeholder secret (and a" >&2
  echo "       placeholder AUTH_SECRET makes web sessions forgeable)." >&2
  echo "       Generate real values (openssl rand -base64 32; -hex 32 for REVALIDATE_SECRET" >&2
  echo "       and INTERNAL_UPLOAD_TOKEN) and re-run. Rotating JWT_SECRET or AUTH_SECRET" >&2
  echo "       signs every user out once." >&2
  preflight_failed=1
fi
# D-ENTRA-01: with ENTRA_ENABLED=1 an invalid Entra configuration makes the
# new cms (register()) and web (first request) refuse to start, after
# `up -d --build` replaced the running containers. Refused here instead.
if [[ -n "${entra_invalid_keys}" ]]; then
  echo "ERROR: ENTRA_ENABLED=1, but these Entra settings in infra/.env are invalid: ${entra_invalid_keys}" >&2
  echo "       The cms and the web refuse to start with them. MS_TENANT_ID and MS_CLIENT_ID must be" >&2
  echo "       GUIDs (never common/organizations/consumers), MS_CLIENT_SECRET set, ENTRA_EXCHANGE_SECRET" >&2
  echo "       32+ characters (openssl rand -hex 32), ENTRA_SYNC_MODE on|dry-run, ENTRA_DEFAULT_ROLE" >&2
  echo "       member|guest|deny, ENTRA_SESSION_TTL <n>m|h|d up to 7d, ENTRA_GROUP_ROLES <role>:<guid>,..." >&2
  echo "       (docs/DEPLOYMENT.md, \"Microsoft Entra ID sign-in\"). Or unset ENTRA_ENABLED." >&2
  preflight_failed=1
fi
if jwt_rotation_missing; then
  echo "ERROR: JWT_SECRET must be rotated for this deploy (D-SESSION-01)." >&2
  echo "       The running web (${PROJECT}-web-1, no ${JWT_OFF_SESSION_LABEL}=${JWT_OFF_SESSION_VALUE} label)" >&2
  echo "       hands every signed-in user their Strapi JWT on /api/auth/session, and those" >&2
  echo "       7-day tokens stay valid until JWT_SECRET changes. Put a fresh value in" >&2
  echo "       infra/.env (openssl rand -base64 32) and re-run: everyone signs in once, open" >&2
  echo "       tabs land on /sign-in?expired=1. Needed again after every roll-forward from" >&2
  echo "       a web rollback to such an image." >&2
  preflight_failed=1
fi
if datetime_repair_env_missing; then
  echo "ERROR: the running database still stores datetimes in the pre-contract format (naive" >&2
  echo "       timestamp columns), and DATETIME_LEGACY_ZONE is not set in infra/.env. The new cms" >&2
  echo "       repairs those values once on its first boot and refuses to start without it." >&2
  echo "       Follow docs/DEPLOYMENT.md, \"Upgrading an existing instance to this release\"" >&2
  echo "       (read-only report, rehearsal on a copy), set DATETIME_LEGACY_ZONE (and, if the old cms" >&2
  echo "       ran in UTC first, DATETIME_LEGACY_UTC_UNTIL) and re-run." >&2
  preflight_failed=1
fi
if ((preflight_failed)); then
  echo "Preflight failed. Nothing was changed." >&2
  exit 1
fi
log "Preflight OK"
if ((CHECK_ONLY)); then
  echo "  --check: nothing deployed."
  exit 0
fi

# How step 4 runs infra/live-smoke.sh: "run …" or "skip: <reason>". The
# switches come from the env compose hands the apps (compose_env_value),
# read as the apps read them: LIVE_EVENTS_DISABLED exactly 1 (web
# lib/live-bus.ts, cms utils/live-events.ts); Entra-only = ENTRA_ENABLED
# exactly 1 without AUTH_LOCAL_ENABLED=1 (web lib/auth-config.ts), where
# live-smoke needs no demo credentials (it skips the sign-in steps itself).
live_smoke_mode() {
  local json live_disabled entra local_signin
  # One compose call; the JSON (secrets included) stays in this function
  # and reaches awk through a pipe, never a file or the terminal.
  json="$("${COMPOSE[@]}" config --format json 2>/dev/null || true)"
  live_disabled="$(printf '%s\n' "${json}" | compose_env_value LIVE_EVENTS_DISABLED)"
  entra="$(printf '%s\n' "${json}" | compose_env_value ENTRA_ENABLED)"
  local_signin="$(printf '%s\n' "${json}" | compose_env_value AUTH_LOCAL_ENABLED)"
  if [[ "${live_disabled}" == "1" ]]; then
    echo "skip: LIVE_EVENTS_DISABLED=1 (the apps run on the polling fallback)"
  elif [[ "${entra}" == "1" && "${local_signin}" != "1" ]]; then
    echo "run (Entra-only: the datetime check, then it skips the sign-in steps)"
  elif [[ -r "${PASSWORDS_FILE}" || (-n "${SMOKE_PASSWORD:-}" && -n "${SMOKE_AUTHOR_PASSWORD:-}") ]]; then
    echo "run"
  else
    echo "skip: demo credentials file ${PASSWORDS_FILE} not readable — run infra/live-smoke.sh manually"
  fi
}

# True (0) when LIVE_SMOKE_MODE says live-smoke does not run for want of the
# demo credentials (a typo in PASSWORDS_FILE, the wrong user) and
# --record-without-live-smoke was not given: step 5 then records nothing,
# as the SSE pipeline went unverified. LIVE_EVENTS_DISABLED=1 (SSE off on
# purpose) and an Entra-only instance (the datetime check alone) record.
unrecorded_live_smoke_skip() {
  [[ "${LIVE_SMOKE_MODE}" == "skip: demo credentials"* ]] && ! ((RECORD_WITHOUT_LIVE_SMOKE))
}

# --- Deploy checks (FX35): lock, checkout, CI ---------------------------------
PHASE="checks"
log "Deploy checks: lock, checkout, CI"
# A second compose project (a staging copy) must not reach production: the
# smoke URL and pg-backup.sh's backup dir default to production's (its
# offsite dir, its retention, its quick-access .env copy), and the Traefik
# overlay's router and service names are fixed (sinnlos-*), so two stacks
# behind one Traefik share or drop each other's routes.
if [[ "${PROJECT}" != "infra" ]]; then
  isolation=()
  [[ -n "${SMOKE_URL_GIVEN}" ]] ||
    isolation+=("SMOKE_URL is not set: the smoke checks would test ${SMOKE_URL}.")
  [[ -n "${SINNLOS_BACKUP_DIR:-}" ]] ||
    isolation+=("SINNLOS_BACKUP_DIR is not set: the pre-deploy backup would go to production's backup dir.")
  if [[ "${DEPLOY_SEPARATE_EDGE:-}" != "1" &&
    -n "$(docker ps -aq --filter label=com.docker.compose.project=infra 2>/dev/null || true)" ]]; then
    isolation+=("containers of compose project infra exist on this Docker host, and the Traefik routers of the overlay have fixed names: set DEPLOY_SEPARATE_EDGE=1 only when this project has a Traefik of its own.")
  fi
  if ((${#isolation[@]})); then
    echo "ERROR: compose project ${PROJECT} is not isolated from production:" >&2
    printf '       - %s\n' "${isolation[@]}" >&2
    echo "       Nothing was changed (docs/DEPLOYMENT.md §3.6, the parameters)." >&2
    exit 1
  fi
fi
# Root may deploy a checkout another user owns: allow it for these calls
# only (a command-line setting; no git config is changed).
GIT=(git -c "safe.directory=${CHECKOUT}" -C "${CHECKOUT}")
if ! HEAD_SHA="$("${GIT[@]}" rev-parse --verify -q HEAD)"; then
  echo "ERROR: ${CHECKOUT} is not a git checkout with a commit; deploy.sh tags the images by commit." >&2
  echo "       Nothing was changed." >&2
  exit 1
fi
NEW_TAG="${HEAD_SHA:0:12}"
GIT_DIR="$("${GIT[@]}" rev-parse --absolute-git-dir)"
STATE_DIR="${DEPLOY_STATE_DIR:-${GIT_DIR}/sinnlos-deploy}"
STATE_FILE="${STATE_DIR}/${PROJECT}.state"
HISTORY_FILE="${STATE_DIR}/${PROJECT}.history"
BOOTSTRAP_FILE="${STATE_DIR}/${PROJECT}.bootstrap"
LOCK_FILE="${STATE_DIR}/${PROJECT}.lock"

if ! command -v flock >/dev/null 2>&1; then
  echo "ERROR: flock (util-linux) is missing; deploy.sh holds a lock so two deploys never overlap." >&2
  echo "       Nothing was changed." >&2
  exit 1
fi
if ((DRY_RUN)); then
  # Read-only: only asks whether a deploy holds the lock right now.
  if [[ -r "${LOCK_FILE}" ]]; then
    exec 9<"${LOCK_FILE}"
    if ! flock -n 9; then
      echo "ERROR: another infra/deploy.sh is running for compose project ${PROJECT} (lock ${LOCK_FILE})." >&2
      exit 1
    fi
    exec 9<&-
  fi
  echo "  lock: free"
else
  if [[ ! -d "${STATE_DIR}" ]]; then
    mkdir -p "${STATE_DIR}"
    own_like_git_dir "${STATE_DIR}"
  fi
  exec 9>>"${LOCK_FILE}"
  own_like_git_dir "${LOCK_FILE}"
  if ! flock -n 9; then
    echo "ERROR: another infra/deploy.sh is running for compose project ${PROJECT} (lock ${LOCK_FILE})." >&2
    echo "       Nothing was changed. Let it finish, then re-run." >&2
    exit 1
  fi
  echo "  lock: ${LOCK_FILE}"
fi

# The images must be exactly the commit their tag names. GIT_OPTIONAL_LOCKS=0
# keeps `git status` from refreshing the index (a dry run writes nothing).
DIRTY="$(GIT_OPTIONAL_LOCKS=0 "${GIT[@]}" status --porcelain --untracked-files=no)"
if [[ -n "${DIRTY}" ]]; then
  echo "ERROR: the checkout ${CHECKOUT} has changed tracked files; the images would not be commit ${NEW_TAG}:" >&2
  head -n 20 <<<"${DIRTY}" | sed 's/^/         /' >&2
  echo "       Commit, stash or revert them (git -C ${CHECKOUT} status), then re-run. Nothing was changed." >&2
  exit 1
fi
UNTRACKED="$(GIT_OPTIONAL_LOCKS=0 "${GIT[@]}" status --porcelain --untracked-files=normal | sed -n 's/^?? //p')"
if [[ -n "${UNTRACKED}" ]]; then
  echo "  NOTE: untracked files in the checkout (part of the build context unless .dockerignore excludes them):"
  head -n 10 <<<"${UNTRACKED}" | sed 's/^/        /'
fi
echo "  checkout: ${CHECKOUT} at ${NEW_TAG} ($("${GIT[@]}" log -1 --format=%s HEAD)), no changed tracked file"

CI="$(ci_status)"
if [[ "${CI}" == green:* ]]; then
  echo "  CI:${CI#green:}"
elif ((REQUIRE_GREEN_CI)); then
  echo "ERROR: --require-green-ci, and CI is ${CI}" >&2
  echo "       Nothing was changed." >&2
  exit 1
else
  echo "WARNING: CI is ${CI}" >&2
  echo "         The deploy goes ahead anyway (infra/deploy.sh --require-green-ci refuses it)." >&2
fi

if ((DRY_RUN)); then
  log "Dry run: the plan (nothing is changed)"
  echo "  1. pre-deploy backup: SINNLOS_BACKUP_KIND=predeploy ${BACKUP_SCRIPT} (none on a first install)"
  echo "  2. rollback target:"
  keep_running_images
  resolve_rollback_target
  echo "     -> ${ROLLBACK_ORIGIN:-none: nothing ran here before (first install)}"
  echo "  3. BUILDX_NO_DEFAULT_ATTESTATIONS=1 ${COMPOSE[*]} build, then ${COMPOSE[*]} up -d --no-build"
  LIVE_SMOKE_MODE="$(live_smoke_mode)"
  echo "  4. smoke check ${SMOKE_URL}; live-smoke: ${LIVE_SMOKE_MODE}"
  if unrecorded_live_smoke_skip; then
    echo "  5. NOT recorded: live-smoke would not run for want of the demo credentials (--record-without-live-smoke records anyway)"
    log "Dry run complete: nothing was changed."
    exit 0
  fi
  echo "  5. tag ${PROJECT}-{web,cms}:${NEW_TAG} (commit ${HEAD_SHA}), record ${STATE_FILE}"
  PRUNE="$(tags_to_prune "${NEW_TAG}" | tr '\n' ' ')"
  echo "     and prune SHA tags beyond the newest ${KEEP_TAGS}: ${PRUNE:-none}"
  log "Dry run complete: nothing was changed."
  exit 0
fi

# --- 1. Pre-deploy database backup ------------------------------------------
PHASE="backup"
log "Pre-deploy database backup"
BACKUP_ENV=(
  SINNLOS_BACKUP_KIND=predeploy
  "SINNLOS_ENV_FILE=${SINNLOS_ENV_FILE:-${INFRA_DIR}/.env}"
  "SINNLOS_DB_CONTAINER=${SINNLOS_DB_CONTAINER:-${PROJECT}-db-1}"
  "SINNLOS_UPLOADS_VOLUME=${SINNLOS_UPLOADS_VOLUME:-${PROJECT}_cms_uploads}"
)
if [[ "${PROJECT}" != "infra" ]]; then
  # Its own backup dir (step 0 insists on it) and its own quick-access .env
  # copy, which pg-backup.sh only refreshes, never creates: absent by
  # default, so production's copy is never overwritten.
  BACKUP_ENV+=(
    "SINNLOS_BACKUP_DIR=${SINNLOS_BACKUP_DIR}"
    "SINNLOS_LOCAL_ENV_BACKUP=${SINNLOS_LOCAL_ENV_BACKUP:-${STATE_DIR}/${PROJECT}.quick-access.env}"
  )
fi
# A first install has no database to back up. Only then: a db container
# that exists but does not run, or a database volume without a container,
# still fails the backup (and the deploy), as it should.
if ! docker inspect "${PROJECT}-db-1" >/dev/null 2>&1 && ! docker volume inspect "${PROJECT}_pgdata" >/dev/null 2>&1; then
  echo "  first install: neither ${PROJECT}-db-1 nor the volume ${PROJECT}_pgdata exists, nothing to back up"
elif [[ -x "${BACKUP_SCRIPT}" ]]; then
  env "${BACKUP_ENV[@]}" "${BACKUP_SCRIPT}"
elif [[ -f "${BACKUP_SCRIPT}" ]]; then
  env "${BACKUP_ENV[@]}" bash "${BACKUP_SCRIPT}"
else
  echo "ERROR: backup script not found at ${BACKUP_SCRIPT}" >&2
  echo "       (it is provisioned separately) — aborting deploy." >&2
  exit 1
fi

# --- 2. Rollback target -------------------------------------------------------
PHASE="rollback-target"
log "Rollback target"
keep_running_images
resolve_rollback_target
if [[ -z "${ROLLBACK_REF}" ]]; then
  echo "  none: nothing ran here before (first install)"
fi

# --- 3. Build + restart -----------------------------------------------------
PHASE="build"
log "Building web and cms"
# Without BuildKit's default provenance attestation every build is a new
# image index, also for unchanged content: :latest would move although
# nothing changed (and, on the containerd image store, leave the running
# image without a name; keep_running_images covers that as well).
BUILDX_NO_DEFAULT_ATTESTATIONS=1 "${COMPOSE[@]}" build
PHASE="start"
log "Starting the stack"
if ! "${COMPOSE[@]}" up -d --no-build; then
  echo "ERROR: docker compose up failed. Usually the new cms did not become healthy (a boot guard" >&2
  echo "       refused to start; the new web waits for it and never starts), so the site is down." >&2
  echo "       Inspect logs:  docker logs --tail=100 ${PROJECT}-cms-1" >&2
  echo "       Fix the cause and re-run, or roll back:" >&2
  print_rollback_hint
  exit 1
fi

# --- 4. Smoke check, then the live pipeline -----------------------------------
PHASE="smoke"
log "Smoke-checking ${SMOKE_URL}"
attempts=10
delay=6
code=000
smoke_ok=0
for ((i = 1; i <= attempts; i++)); do
  # curl writes 000 itself when there is no answer.
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "${SMOKE_URL}")" || true
  code="${code:-000}"
  if [[ "${code}" =~ ^(200|301|302|307|308)$ ]]; then
    smoke_ok=1
    break
  fi
  if ((i < attempts)); then
    echo "  attempt ${i}/${attempts}: HTTP ${code} — retrying in ${delay}s"
    sleep "${delay}"
  fi
done
if ! ((smoke_ok)); then
  echo "ERROR: smoke check failed — ${SMOKE_URL} returned HTTP ${code}" >&2
  echo "       Inspect logs:  ${COMPOSE[*]} logs --tail=100 web cms" >&2
  print_rollback_hint
  exit 1
fi
log "Smoke check OK (HTTP ${code} after ${i} attempt(s))"

# The SSE chain is fire-and-forget and can fail silently while every
# container reports healthy — this probe is the only end-to-end proof
# (issue #17/#27).
PHASE="live-smoke"
LIVE_SMOKE_MODE="$(live_smoke_mode)"
if [[ "${LIVE_SMOKE_MODE}" == run* ]]; then
  log "Running live-pipeline smoke (infra/live-smoke.sh)"
  # Its output also goes to a file, for the one line that says the
  # notification frame path went unchecked (no secrets in it).
  LIVE_SMOKE_OUT="$(mktemp)"
  if ! BASE_URL="${SMOKE_URL%/}" PASSWORDS_FILE="${PASSWORDS_FILE}" CMS_CONTAINER="${PROJECT}-cms-1" \
    WEB_CONTAINER="${PROJECT}-web-1" DB_CONTAINER="${PROJECT}-db-1" "${LIVE_SMOKE_SCRIPT}" | tee "${LIVE_SMOKE_OUT}"; then
    rm -f "${LIVE_SMOKE_OUT}"
    echo "ERROR: live-smoke failed — the SSE pipeline is NOT delivering pings, or a check above failed." >&2
    echo "       App still works on polling fallback; investigate before calling this deploy done:" >&2
    echo "       docker logs ${PROJECT}-cms-1 2>&1 | grep live-emit ; docker logs ${PROJECT}-web-1 2>&1 | grep '\\[live\\]'" >&2
    echo "       This deploy is NOT recorded as last-known-good. Fix and re-run, or roll back:" >&2
    print_rollback_hint
    exit 1
  fi
  if [[ "${LIVE_SMOKE_MODE}" == "run (Entra-only"* ]]; then
    LIVE_SMOKE_RESULT="passed: the datetime check only (Entra-only instance)"
  elif grep -q 'the notification frame path was not checked' "${LIVE_SMOKE_OUT}"; then
    LIVE_SMOKE_RESULT="passed (notification frame not checked)"
    echo "WARNING: live-smoke did not check the notification frame path: the stream user has no announcement" >&2
    echo "         of their own. Give ${PASSWORDS_FILE} a line for an announcement author, or set SMOKE_EMAIL" >&2
    echo "         (docs/DEPLOYMENT.md, \"Upgrading to the deploy, backup and cron hardening\")." >&2
  else
    LIVE_SMOKE_RESULT="passed"
  fi
  rm -f "${LIVE_SMOKE_OUT}"
else
  log "live-smoke SKIPPED: ${LIVE_SMOKE_MODE#skip: }"
  LIVE_SMOKE_RESULT="${LIVE_SMOKE_MODE}"
fi

# --- 5. Last-known-good -----------------------------------------------------
if unrecorded_live_smoke_skip; then
  echo "WARNING: live-smoke did not run; this deploy is NOT recorded as last-known-good (the rollback target" >&2
  echo "         stays ${ROLLBACK_ORIGIN:-as it was}). Run infra/live-smoke.sh with the demo credentials, then" >&2
  echo "         re-run with a readable PASSWORDS_FILE, or with --record-without-live-smoke." >&2
  PHASE="done"
  log "Deploy complete, NOT recorded as last-known-good."
  exit 0
fi
PHASE="record"
log "Recording ${PROJECT}-{web,cms}:${NEW_TAG} as last-known-good"
RECORDED=0
record_last_known_good
PHASE="prune"
if ((RECORDED)); then
  log "Pruning SHA tags beyond the newest ${KEEP_TAGS}"
  prune_sha_tags || echo "WARNING: pruning the SHA tags failed; the deploy itself is complete." >&2
else
  # The state still names the previous deploy: its SHA tags must stay.
  echo "WARNING: the state was not written, so no SHA tag is pruned (every older one stays)." >&2
fi
PHASE="done"
log "Deploy complete."
