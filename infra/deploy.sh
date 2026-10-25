#!/usr/bin/env bash
#
# deploy.sh — direct deploy for the 'sinnlos' intranet (docker compose project 'infra').
#
# What it does, in order:
#   0. Preflight of infra/.env against the env contract (FX13): required
#      keys set, no template placeholder in the secrets, digest sender set
#      when SMTP is, a valid Entra configuration when
#      ENTRA_ENABLED=1 (D-ENTRA-01: cms and web would refuse to start),
#      the profile and keys of the optional Meilisearch when
#      MEILISEARCH_ENABLED=1, and a master key whenever its profile is on
#      (v0.21: the meili container would not start),
#      no wiki revision draft rows while this release runs wiki revisions
#      without draft & publish (batch 16: the new cms would refuse to
#      start; infra/migrations/wiki-revision-dp/migrate.sql first),
#      the site open at the edge (no SITE_ALLOW_CIDRS: a deploy is no
#      step of the restricted restore), and a DOMAIN the edge serves: a bare host name (with Caddy optionally
#      with http:// or https://), no placeholder, the host of WEB_PUBLIC_URL
#      and CMS_PUBLIC_URL (with Traefik: the host every router matches).
#      With the Caddy edge, no container of the project may carry Traefik
#      labels (DEPLOY_EDGE=traefik is missing: Caddy would claim 80/443
#      next to the host Traefik).
#      Then the deploy checks (FX35): one deploy per compose project at a
#      time (flock; each infra/restore-db.sh step holds the same lock), no
#      database restore in progress (its reservation), a clean checkout (no
#      changed tracked file, and no
#      untracked file where the images are built from), and the
#      GitHub CI result of the commit (a warning, or a refusal with
#      --require-green-ci). Fails before anything is touched.
#   1. Pre-deploy backup: infra/backup/pg-backup.sh into SINNLOS_BACKUP_DIR
#      (artifacts named -predeploy; a partial one fails the deploy). Project
#      infra on a host with its own backup service (BACKUP_RUN, the owner's
#      srv-prod-01-ops): `sudo -n "$BACKUP_RUN" --kind predeploy sinnlos`,
#      which a sudoers drop-in allows exactly. Skipped only on a first
#      install (no db container and no database volume yet).
#   2. The rollback target: the images of the last-known-good deploy,
#      <project>-{web,cms}:<sha> from the state file (below). Without a usable
#      state (the first run of this version of the script, or those images
#      are gone) the running images are tagged :rollback, as before, and
#      recorded in a marker file; a running image that cannot be tagged, or
#      a marker that cannot be written, stops the run before the build. The
#      running images are also tagged :pre-deploy, on every run, so they
#      stay resolvable through the build (keep_running_images).
#   3. Build web and cms (without BuildKit's default attestations, so an
#      unchanged rebuild keeps its image id; SINNLOS_REVISION = the commit),
#      or with DEPLOY_IMAGE_SOURCE=registry pull the published images of the
#      checkout's release tag (both, checked against the commit and the
#      version, before any local tag moves); then restart the stack (with the
#      Traefik override when DEPLOY_EDGE=traefik).
#   4. Curl smoke check of the live site, then infra/live-smoke.sh.
#   5. Only after both passed: tag the images <project>-{web,cms}:<sha> (the
#      first 12 characters of the commit), record them as last-known-good in
#      the state file, and prune older SHA tags (DEPLOY_KEEP_TAGS, 5). A
#      live-smoke that was skipped for want of the demo credentials file
#      records nothing (--record-without-live-smoke records anyway); one
#      skipped for LIVE_EVENTS_DISABLED=1, or the datetime check alone on an
#      identity-provider-only instance (Entra or OIDC), counts as passed.
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
# Parameters (environment, or infra/deploy.env: infra/deploy.env.example;
# the environment wins):
#   DEPLOY_EDGE       caddy (the bundled Caddy, default) or traefik (a host
#                     Traefik, docker-compose.traefik.yml)
#   DEPLOY_IMAGE_SOURCE build (default) or registry (ghcr.io images of the
#                     checkout's release tag)
#   SMOKE_URL         WEB_PUBLIC_URL with Caddy, https://<DOMAIN> (the host
#                     every router matches) with Traefik (smoke check and
#                     live-smoke)
#   PASSWORDS_FILE    "email password" lines for live-smoke (none by default:
#                     live-smoke then does not run, see step 5)
#   SINNLOS_CHECKOUT  the checkout this script lives in (compose files, git)
#   COMPOSE_PROJECT   infra (containers <project>-web-1 …, images <project>-web …);
#                     another project also needs SMOKE_URL, SINNLOS_BACKUP_DIR
#                     and, next to project infra's containers,
#                     DEPLOY_SEPARATE_EDGE=1 (a Traefik of its own)
#   DEPLOY_STATE_DIR  <common git dir of the clone>/sinnlos-deploy (state, history,
#                     lock, and in restore/ infra/restore-db.sh's state and
#                     reservation; shared by its worktrees; a second clone deploying
#                     or restoring the same project must point it at the same
#                     directory)
#   DEPLOY_KEEP_TAGS  5 (SHA tags kept per image)
#   SINNLOS_BACKUP_DIR the pre-deploy backup's dir (pg-backup.sh)
#   BACKUP_RUN        project infra only: the host's backup service, run
#                     through `sudo -n` instead of pg-backup.sh
#                     (DEPLOY_BACKUP_NO_SUDO=1 runs it without sudo: tests)
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
# Host settings from infra/deploy.env, before any default below.
# shellcheck disable=SC1091 # the library next to this script, checked on its own
source "${INFRA_DIR}/deploy-env.sh"
load_deploy_env "${INFRA_DIR}/deploy.env" "${CHECKOUT}"

COMPOSE_BASE="${INFRA_DIR}/docker-compose.yml"
COMPOSE_TRAEFIK="${INFRA_DIR}/docker-compose.traefik.yml"
BACKUP_SCRIPT="${INFRA_DIR}/backup/pg-backup.sh"
# Project infra's pre-deploy backup on a host with its own backup service
# (BACKUP_RUN): as root through `sudo -n` (never a password prompt; a sudoers
# drop-in allows exactly these arguments). Without it, pg-backup.sh.
BACKUP_RUN="${BACKUP_RUN:-}"
if [[ "${DEPLOY_BACKUP_NO_SUDO:-}" == 1 ]]; then
  BACKUP_RUN_CMD=("${BACKUP_RUN}" --kind predeploy sinnlos)
else
  BACKUP_RUN_CMD=(sudo -n "${BACKUP_RUN}" --kind predeploy sinnlos)
fi
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
DEPLOY_EDGE="${DEPLOY_EDGE:-caddy}"
case "${DEPLOY_EDGE}" in
  caddy) COMPOSE=(docker compose -p "${PROJECT}" -f "${COMPOSE_BASE}") ;;
  traefik) COMPOSE=(docker compose -p "${PROJECT}" -f "${COMPOSE_BASE}" -f "${COMPOSE_TRAEFIK}") ;;
  *)
    echo "ERROR: DEPLOY_EDGE must be caddy or traefik: ${DEPLOY_EDGE}" >&2
    exit 2
    ;;
esac
DEPLOY_IMAGE_SOURCE="${DEPLOY_IMAGE_SOURCE:-build}"
if [[ "${DEPLOY_IMAGE_SOURCE}" != build && "${DEPLOY_IMAGE_SOURCE}" != registry ]]; then
  echo "ERROR: DEPLOY_IMAGE_SOURCE must be build or registry: ${DEPLOY_IMAGE_SOURCE}" >&2
  exit 2
fi
# The published images (.github/workflows/release-images.yml).
IMAGE_REPO="ghcr.io/yurtbayemre/sinnlos"

# Whether the caller named the smoke URL (another project must). Without
# it, the smoke URL is set once the preflight has checked the host the edge
# serves (caddy_host_scan / traefik_host_scan).
SMOKE_URL_GIVEN="${SMOKE_URL:+1}"
SMOKE_URL="${SMOKE_URL:-}"
PASSWORDS_FILE="${PASSWORDS_FILE:-}"
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
# runs at start, so both would refuse to start), "entra-inert MS_CLIENT_ID"
# (MS_* values left in infra/.env without ENTRA_ENABLED=1: ignored), "oidc-invalid KEY" (v0.25.0:
# OIDC_ENABLED=1 and KEY fails the check the cms (apps/cms/src/oidc/config.ts)
# or the web (apps/web/src/lib/auth-config.ts) runs at start; ENTRA_ENABLED
# when both are on), "boot-invalid KEY" (v0.28: a value the cms refuses to
# boot with: TRAINING_EVIDENCE_RETENTION_YEARS, SEARCH_LOG_RETENTION_DAYS,
# FEATURES_OFF), "meili-invalid KEY" (v0.21:
# MEILISEARCH_ENABLED=1 without the search profile or a key of the
# optional Meilisearch, or the profile on with a master key the meili
# container refuses to start with).
# The key lists, the markers, the digest rule, the Entra and the
# Meilisearch rules are pinned against env-guard.ts, send-digests.ts,
# entra/config.ts, the web's auth-config.ts and infra/docker-compose.yml by
# apps/cms/src/utils/deploy-preflight.test.ts.
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
    # The v0.28 boot checks judge plain ASCII only: the JSON whitespace
    # escapes become blanks, and a value with anything else (another
    # escape, a non-ASCII character such as a no-break space, which
    # trim() in JavaScript removes) is left to the cms. So the preflight never
    # refuses a value the cms would accept.
    function unjudgeable(v) {
      gsub(/\\[tnrf]/, " ", v)
      return v ~ /\\|[^ -~]/
    }
    function blanks(v) {
      gsub(/\\[tnrf]/, " ", v)
      return v
    }
    # A whole number from lo to hi, or unset/blank (the default).
    function int_in(v, lo, hi) {
      if (unjudgeable(v)) return 1
      v = trim(blanks(v))
      if (v == "") return 1
      if (v !~ /^[0-9]+$/) return 0
      return v + 0 >= lo && v + 0 <= hi
    }
    # FEATURES_OFF: a comma list of switch names, any case, blanks around
    # and empty entries ignored (parseFeaturesOff, packages/domain/src/features.ts).
    function switches_ok(v,    n, i, parts, p) {
      if (unjudgeable(v)) return 1
      n = split(tolower(blanks(v)), parts, ",")
      for (i = 1; i <= n; i++) {
        p = trim(parts[i])
        if (p != "" && !(p in switch_name)) return 0
      }
      return 1
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
      n = split("events training marketplace kudos celebrations polls duty-plans kpis read-confirmations training-reports search-logging", k, " ")
      for (i = 1; i <= n; i++) switch_name[k[i]] = 1
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
      } else if (env["MS_CLIENT_ID"] != "" || env["AUTH_MICROSOFT_ENTRA_ID_SECRET"] != "") {
        print "entra-inert MS_CLIENT_ID"
      }
      # v0.25.0 OIDC: OIDC_ENABLED is the only switch (exactly "1"). With it,
      # every value the cms and the web validate at start (the web alone
      # reads OIDC_CLIENT_SECRET, OIDC_SCOPE and OIDC_DISPLAY_NAME).
      if (env["OIDC_ENABLED"] == "1") {
        if (env["ENTRA_ENABLED"] == "1") print "oidc-invalid ENTRA_ENABLED"
        issuer = trim(env["OIDC_ISSUER"])
        if (length(issuer) > 255 || issuer ~ /[ \t]/ || !(issuer ~ /^https:\/\/[^\/]/ || (env["OIDC_ALLOW_HTTP"] == "1" && issuer ~ /^http:\/\/[^\/]/))) print "oidc-invalid OIDC_ISSUER"
        client = trim(env["OIDC_CLIENT_ID"])
        if (client == "" || length(client) > 255) print "oidc-invalid OIDC_CLIENT_ID"
        if (trim(env["OIDC_CLIENT_SECRET"]) == "") print "oidc-invalid OIDC_CLIENT_SECRET"
        if (length(trim(env["OIDC_EXCHANGE_SECRET"])) < 32 || placeholder(env["OIDC_EXCHANGE_SECRET"])) print "oidc-invalid OIDC_EXCHANGE_SECRET"
        role = trim(env["OIDC_DEFAULT_ROLE"])
        if (role != "" && role != "member" && role != "guest" && role != "deny") print "oidc-invalid OIDC_DEFAULT_ROLE"
        if (!ttl_ok(env["OIDC_SESSION_TTL"])) print "oidc-invalid OIDC_SESSION_TTL"
        org = trim(env["OIDC_ZITADEL_ORG_ID"])
        if ((org != "" && org !~ /^[0-9]+$/) || (org == "" && trim(env["OIDC_ROLES_CLAIM"]) ~ /^urn:zitadel:/)) print "oidc-invalid OIDC_ZITADEL_ORG_ID"
        # Claim names or dot-separated paths (oidc/config.ts CLAIM_PATH).
        roles_claim = trim(env["OIDC_ROLES_CLAIM"])
        if (roles_claim != "" && roles_claim !~ /^[A-Za-z0-9_:\/-]+(\.[A-Za-z0-9_:\/-]+)*$/) print "oidc-invalid OIDC_ROLES_CLAIM"
        dept_claim = trim(env["OIDC_DEPARTMENT_CLAIM"])
        if (dept_claim != "" && dept_claim !~ /^[A-Za-z0-9_:\/-]+(\.[A-Za-z0-9_:\/-]+)*$/) print "oidc-invalid OIDC_DEPARTMENT_CLAIM"
        scope = trim(env["OIDC_SCOPE"])
        if (scope != "" && (" " scope " ") !~ /[ \t]openid[ \t]/) print "oidc-invalid OIDC_SCOPE"
        if (length(trim(env["OIDC_DISPLAY_NAME"])) > 40) print "oidc-invalid OIDC_DISPLAY_NAME"
      }
      # v0.28: the cms refuses to boot with these (register(): utils/
      # training-evidence.ts, cron/prune-search-logs.ts, the FEATURES_OFF
      # parser), so they fail here, before the backup and the build.
      if (!int_in(env["TRAINING_EVIDENCE_RETENTION_YEARS"], 1, 30)) print "boot-invalid TRAINING_EVIDENCE_RETENTION_YEARS"
      if (!int_in(env["SEARCH_LOG_RETENTION_DAYS"], 1, 3650)) print "boot-invalid SEARCH_LOG_RETENTION_DAYS"
      if (!switches_ok(env["FEATURES_OFF"])) print "boot-invalid FEATURES_OFF"
      # v0.21 Meilisearch: compose renders MEILI_MASTER_KEY (the meili
      # service) only while the search profile is on (COMPOSE_PROFILES in
      # infra/.env). In production Meilisearch does not start without a
      # master key of 16+ bytes. MEILISEARCH_ENABLED is on at exactly "1",
      # as the cms and the web read it, and then needs the profile and both
      # restricted keys.
      meili = ("MEILI_MASTER_KEY" in env)
      if (meili && (length(trim(env["MEILI_MASTER_KEY"])) < 16 || placeholder(env["MEILI_MASTER_KEY"]))) print "meili-invalid MEILI_MASTER_KEY"
      if (env["MEILISEARCH_ENABLED"] == "1") {
        if (!meili) print "meili-invalid COMPOSE_PROFILES"
        if (trim(env["MEILISEARCH_URL"]) == "") print "meili-invalid MEILISEARCH_URL"
        if (trim(env["MEILISEARCH_WRITE_KEY"]) == "" || placeholder(env["MEILISEARCH_WRITE_KEY"])) print "meili-invalid MEILISEARCH_WRITE_KEY"
        if (trim(env["MEILISEARCH_SEARCH_KEY"]) == "" || placeholder(env["MEILISEARCH_SEARCH_KEY"])) print "meili-invalid MEILISEARCH_SEARCH_KEY"
      }
    }' | sort -u
}

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

# Traefik host (5A-T1): every router of the Traefik overlay matches
# Host(`${DOMAIN}`) from infra/.env, and compose refuses only an unset or
# empty DOMAIN. A scheme, a port, a typo or the example host of
# infra/.env.example renders fine, and then no router matches: the whole
# site answers Traefik's 404, and an image rollback does not help (the
# labels are wrong, not the images). So the preflight reads the host the
# routers will match from the rendered labels and requires one host for
# every router, a bare host name (no scheme, port, path or blank), no
# placeholder, and the host of WEB_PUBLIC_URL (the web's AUTH_URL) and of
# CMS_PUBLIC_URL (the cms's PUBLIC_URL): the overlay serves both apps on
# that one host. Host names are no secrets, so the messages show them.
TRAEFIK_HOST_RE='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$'
# Documentation names (RFC 2606: example.com/.net/.org and the .example and
# .invalid TLDs; infra/.env.example ships intranet.example.com) and
# template markers.
TRAEFIK_HOST_PLACEHOLDER_RE='(^|\.)(example\.(com|net|org)|example|invalid)$|change-?me|placeholder|your-?domain'

# The host of an http(s) URL, in lower case; nothing for anything else.
url_host() {
  local host
  [[ "$1" =~ ^[Hh][Tt][Tt][Pp][Ss]?://([^/?#]*) ]] || return 0
  host="${BASH_REMATCH[1]##*@}"
  host="${host%%:*}"
  printf '%s\n' "${host,,}"
}

# Reads `compose config --format json` on stdin (the rendered Traefik
# labels and the apps' env; secrets stay inside this function). Prints
# "host <name>" for the one host every router matches, and "problem <text>"
# for each finding (none: DOMAIN fits).
traefik_host_scan() {
  local json rules hosts host web cms
  json="$(cat)"
  rules="$(grep -E '^[[:space:]]*"traefik\.http\.routers\.[^"]+\.rule": ' <<<"${json}" || true)"
  # The backticks are Traefik's rule syntax, matched literally.
  # shellcheck disable=SC2016
  hosts="$(grep -o 'Host(`[^`]*`)' <<<"${rules}" | sort -u || true)"
  if [[ -z "${hosts}" ]]; then
    echo "problem no Traefik router rule has a Host() matcher"
    return 0
  fi
  if [[ "${hosts}" == *$'\n'* ]]; then
    echo "problem the Traefik routers match different hosts: $(tr '\n' ' ' <<<"${hosts}")"
    return 0
  fi
  host="$(sed -e 's/^Host(`//' -e 's/`)$//' <<<"${hosts}")"
  echo "host ${host}"
  if [[ -z "${host}" ]]; then
    echo "problem DOMAIN is empty"
    return 0
  fi
  if ((${#host} > 253)) || ! [[ "${host,,}" =~ ${TRAEFIK_HOST_RE} ]]; then
    echo "problem DOMAIN=${host} is not a bare host name (the name alone: no scheme, port, path or blank)"
    return 0
  fi
  if [[ "${host,,}" =~ ${TRAEFIK_HOST_PLACEHOLDER_RE} ]]; then
    echo "problem DOMAIN=${host} is a placeholder (infra/.env.example), not this instance's host name"
  fi
  web="$(url_host "$(compose_env_value AUTH_URL <<<"${json}")")"
  cms="$(url_host "$(compose_env_value PUBLIC_URL <<<"${json}")")"
  if [[ "${web}" != "${host,,}" ]]; then
    echo "problem DOMAIN=${host} is not the host of WEB_PUBLIC_URL (${web:-no http(s) URL})"
  fi
  if [[ "${cms}" != "${host,,}" ]]; then
    echo "problem DOMAIN=${host} is not the host of CMS_PUBLIC_URL (${cms:-no http(s) URL})"
  fi
}

# Caddy edge: the same rules for DOMAIN, the bundled Caddy's site address
# (a host name, optionally with http:// or https://; empty renders as
# localhost). Compose publishes only 80 and 443, and Caddy serves plain HTTP
# only for an http:// DOMAIN: a DOMAIN or public URL with another port, or a
# public URL with the other scheme, is refused (the site would be
# unreachable or sign-in broken). Prints "host <name>", "origin
# <WEB_PUBLIC_URL>" (the smoke URL's default) and "problem <text>" lines
# like traefik_host_scan.
CADDY_PORT_RE='^([A-Za-z]+://)?[^/]*:([0-9]+)(/|$)'
caddy_host_scan() {
  local json domain host web cms web_url cms_url scheme port pair pair_value
  json="$(cat)"
  domain="$(compose_env_value DOMAIN <<<"${json}")"
  web_url="$(compose_env_value AUTH_URL <<<"${json}")"
  cms_url="$(compose_env_value PUBLIC_URL <<<"${json}")"
  host="${domain#*://}"
  host="${host%%[:/]*}"
  echo "host ${host,,}"
  echo "origin ${web_url%/}"
  if [[ -z "${host}" ]] || ((${#host} > 253)) || ! [[ "${host,,}" =~ ${TRAEFIK_HOST_RE} ]]; then
    echo "problem DOMAIN=${domain} is not a host name (optionally with http:// or https://)"
    return 0
  fi
  if [[ "${host,,}" =~ ${TRAEFIK_HOST_PLACEHOLDER_RE} ]]; then
    echo "problem DOMAIN=${domain} is a placeholder (infra/.env.example), not this instance's host name"
  fi
  scheme=https
  port=443
  if [[ "${domain,,}" == http://* ]]; then
    scheme=http
    port=80
  fi
  for pair in "DOMAIN=${domain}" "WEB_PUBLIC_URL=${web_url}" "CMS_PUBLIC_URL=${cms_url}"; do
    if [[ "${pair#*=}" =~ ${CADDY_PORT_RE} && "${BASH_REMATCH[2]}" != "${port}" ]]; then
      echo "problem ${pair} names port ${BASH_REMATCH[2]}: the bundled Caddy serves ${scheme} on port ${port} only"
    fi
  done
  for pair in "WEB_PUBLIC_URL=${web_url}" "CMS_PUBLIC_URL=${cms_url}"; do
    pair_value="${pair#*=}"
    if [[ "${pair_value,,}" != "${scheme}://"* ]]; then
      echo "problem ${pair} is not an ${scheme}:// URL, and DOMAIN=${domain} makes Caddy serve ${scheme}"
    fi
  done
  web="$(url_host "${web_url}")"
  cms="$(url_host "${cms_url}")"
  if [[ "${web}" != "${host,,}" ]]; then
    echo "problem DOMAIN=${domain} is not the host of WEB_PUBLIC_URL (${web:-no http(s) URL})"
  fi
  if [[ "${cms}" != "${host,,}" ]]; then
    echo "problem DOMAIN=${domain} is not the host of CMS_PUBLIC_URL (${cms:-no http(s) URL})"
  fi
}

# Batch 16 (DA03): wiki revisions run without draft & publish from the
# release whose wiki-revision schema says so. On a database that still
# holds revision rows with published_at IS NULL (after a rollback to a
# release before it, whose first boot cloned a draft twin of every
# revision), the new cms refuses to start (apps/cms/src/utils/
# revision-dp-guard.ts; without that guard Strapi would delete them). The
# deploy is refused here instead, before the backup and before any
# container changes, naming infra/migrations/wiki-revision-dp/migrate.sql.
REVISION_SCHEMA="apps/cms/src/api/wiki-revision/content-types/wiki-revision/schema.json"
REVISION_DP_RUNBOOK='infra/migrations/wiki-revision-dp/README.md'

# Prints the number of wiki_revisions rows with published_at IS NULL in the
# running database (0 without the table), or nothing when there is no db
# container to ask or the query gave up (after 5 s waiting for a lock, 10 s
# in all). Arguments run in front of the docker call (PROBE_TIMEOUT).
revision_draft_rows() {
  # shellcheck disable=SC2016
  "$@" docker exec -i "${PROJECT}-db-1" sh -c 'psql -X -q -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB"' 2>/dev/null <<'SQL'
SET lock_timeout = '5s';
SET statement_timeout = '10s';
SELECT to_regclass('public.wiki_revisions') IS NOT NULL AS has_revisions \gset
\if :has_revisions
SELECT count(*) FROM public.wiki_revisions WHERE published_at IS NULL;
\else
SELECT 0;
\endif
SQL
}

# Whether this checkout runs wiki revisions without draft & publish (its
# schema says draftAndPublish false).
checkout_revisions_dp_off() {
  [[ -f "${CHECKOUT}/${REVISION_SCHEMA}" ]] &&
    grep -Eq '"draftAndPublish"[[:space:]]*:[[:space:]]*false' "${CHECKOUT}/${REVISION_SCHEMA}"
}

# The rollback hint runs on a failed deploy and must print every line, also
# with a hung docker daemon or a locked database: each of its docker calls
# runs under this bound. `timeout` exits 124 at the deadline (137 after the
# kill) and 127 when it is missing; the hint then treats what that call
# would have told as unknown and prints the safe variant.
PROBE_TIMEOUT=(timeout -k 5 15)

# The rollback target of this deploy (step 2): the images
# <project>-{web,cms}:<ROLLBACK_REF>. ROLLBACK_REF is the SHA tag of the
# last-known-good deploy from the state file, or "rollback" when this run
# tagged the running images (no usable state yet), or empty when there is
# nothing to go back to (a fresh install). ROLLBACK_ORIGIN says which.
ROLLBACK_REF=""
ROLLBACK_ORIGIN=""

# The upgrade floor: v0.25.0 (main 0c26656e). The rollback commands are
# printed only for a target this checkout's history shows at or after that
# commit. The special cases of older targets (the datetime repair and its
# legacy-zone overrides, the guest vote permission, the token version of
# batch 13, pnpm starts, exam modes, wiki revision drafts) left the script
# with v0.29; their runbooks are in docs/archive/deployment-history.md.
FLOOR_COMMIT="0c26656e98f930d6298ae5ee3b3234ba7fdc780f"

# One field of rollback image $2 (docker inspect format $1), or nothing:
# bounded (PROBE_TIMEOUT), never pulls; a failed or hung docker call gives
# nothing.
image_field() {
  "${PROBE_TIMEOUT[@]}" docker image inspect -f "$1" "$2" 2>/dev/null || true
}

# The commit both rollback images (ROLLBACK_REF) come from, when every
# identity they carry agrees and this checkout's full history shows it at or
# after FLOOR_COMMIT. The identities: each image's
# org.opencontainers.image.revision label (set since v0.26) and, for the
# last-known-good target, the state's SHA, its TAG and the image ids it
# recorded (v0.25 images carry no label). False when that cannot be shown:
# an image missing here, a SHA target whose images are not the recorded ones
# (a tag moved), a :rollback target without both labels, a label or SHA this
# checkout does not know, identities that disagree, a shallow history, or a
# commit before the floor.
rollback_target_commit() {
  local svc image id label commit full=""
  local -a ids=() candidates=()
  [[ "$("${GIT[@]}" rev-parse --is-shallow-repository 2>/dev/null)" == false ]] || return 1
  for svc in web cms; do
    image="${PROJECT}-${svc}:${ROLLBACK_REF}"
    id="$(image_field '{{.Id}}' "${image}")"
    [[ -n "${id}" ]] || return 1
    ids+=("${id}")
    label="$(image_field '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${image}")"
    if [[ "${label}" =~ ^[0-9a-f]{12,40}$ ]]; then candidates+=("${label}"); fi
  done
  if [[ "${ROLLBACK_REF}" != rollback ]]; then
    [[ "${STATE_SHA:-}" =~ ^[0-9a-f]{40}$ && "${STATE_SHA:0:12}" == "${ROLLBACK_REF}" ]] || return 1
    [[ "${ids[0]}" == "${STATE_WEB_IMAGE:-}" && "${ids[1]}" == "${STATE_CMS_IMAGE:-}" ]] || return 1
    candidates+=("${STATE_SHA}")
  elif ((${#candidates[@]} < 2)); then
    return 1
  fi
  for commit in "${candidates[@]}"; do
    commit="$("${GIT[@]}" rev-parse --verify -q "${commit}^{commit}" 2>/dev/null)" || return 1
    [[ -z "${full}" || "${full}" == "${commit}" ]] || return 1
    full="${commit}"
  done
  "${GIT[@]}" merge-base --is-ancestor "${FLOOR_COMMIT}" "${full}" 2>/dev/null || return 1
  printf '%s\n' "${full}"
}

# The rollback commands for a failed deploy, for the target above, when it
# is a verified v0.25+ release (rollback_target_commit); otherwise only where
# to check it by hand. Printing only: it never changes the target.
print_rollback_hint() {
  if [[ -z "${ROLLBACK_REF}" ]]; then
    echo "       There is no earlier release on this host to roll back to (no last-known-good state and" >&2
    echo "       no containers ran before this deploy): fix the cause and re-run." >&2
    return 0
  fi
  local web_image="${PROJECT}-web:${ROLLBACK_REF}" cms_image="${PROJECT}-cms:${ROLLBACK_REF}" commit
  if commit="$(rollback_target_commit)"; then
    echo "       To roll back to ${ROLLBACK_ORIGIN:-${web_image} and ${cms_image}} (commit ${commit:0:12}), retag, then start without a build:" >&2
    echo "                      docker tag ${web_image} ${PROJECT}-web:latest" >&2
    echo "                      docker tag ${cms_image} ${PROJECT}-cms:latest" >&2
    echo "                      ${COMPOSE[*]} up -d --no-build web cms" >&2
    echo "       (--no-build is essential — --build would rebuild the broken image)" >&2
  else
    echo "       The rollback target ${ROLLBACK_REF} (${web_image}, ${cms_image}) is not a verified v0.25+ release:" >&2
    echo "       its images and the state do not agree on one commit of this checkout at or after v0.25.0." >&2
    echo "       Check it by hand (docs/UPGRADE.md, \"Rollback\"); releases before v0.25:" >&2
    echo "       docs/archive/deployment-history.md." >&2
  fi
  if [[ "${ROLLBACK_REF}" == "rollback" ]]; then
    echo "       Rollback target: :rollback, the images that ran before the first deploy with this script (no" >&2
    echo "       last-known-good state yet); a re-run before the first successful deploy keeps this :rollback" >&2
    echo "       (${BOOTSTRAP_FILE}, docs/UPGRADE.md, \"Rollback\")." >&2
  else
    echo "       Rollback target: the last-known-good state (${STATE_FILE}); a re-run of this" >&2
    echo "       script keeps it until a deploy passes the smoke check and live-smoke (docs/UPGRADE.md, \"Rollback\")." >&2
  fi
}

# --- Last-known-good state (FX35) --------------------------------------------
# Written only after the smoke check and live-smoke passed: the commit, its
# SHA tag and the image ids web and cms ran with. A plain key=value file,
# read back by key (never sourced). Kept in the clone's common git dir by
# default: outside the working tree, never committed, the same for every
# user that runs this script on the host and for every worktree.
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

# Writes BOOTSTRAP_FILE for the :rollback tags this run set. False when it
# cannot (its temp file removed): without the marker, a re-run after a
# deploy that failed after `up` would tag the failed images :rollback, so
# the caller stops before the build.
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
    return 1
  fi
}

# A file this script creates in the state dir as root gets the owner of the
# git dir, so the checkout's owner can deploy (and write it) next time.
own_like_git_dir() {
  if ((EUID == 0)); then
    chown --reference="${REPO_GIT_DIR}" "$@" 2>/dev/null || true
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
  # Every running image must resolve before either :rollback moves: a
  # running image that cannot (containerd image store, no tag names it)
  # would leave its service's :rollback on an older image, or none, next to
  # the other service's current one. Refused before anything is tagged.
  local entry
  local -a running=() unresolved=()
  for svc in web cms; do
    container="${PROJECT}-${svc}-1"
    if img="$(docker inspect --format '{{.Image}}' "${container}" 2>/dev/null)" && [[ -n "${img}" ]]; then
      if docker image inspect "${img}" >/dev/null 2>&1; then
        running+=("${svc} ${img}")
      else
        unresolved+=("${svc} ${img}")
      fi
    else
      echo "  ${container} not running — nothing to roll back to for ${svc}"
    fi
  done
  if ((${#unresolved[@]})); then
    refuse_rollback_target "${unresolved[@]}"
  fi
  for entry in ${running[@]+"${running[@]}"}; do
    svc="${entry%% *}"
    img="${entry#* }"
    container="${PROJECT}-${svc}-1"
    if ((DRY_RUN)); then
      echo "  would tag ${container} (${img}) as ${PROJECT}-${svc}:rollback"
    elif docker tag "${img}" "${PROJECT}-${svc}:rollback"; then
      echo "  ${container} (${img}) -> ${PROJECT}-${svc}:rollback"
    else
      refuse_rollback_target "${entry}"
    fi
    tagged=$((tagged + 1))
  done
  if ((tagged == 2)); then
    ROLLBACK_REF="rollback"
    ROLLBACK_ORIGIN="the images that ran before this deploy (:rollback)"
  elif ((tagged == 1)) && docker image inspect "${PROJECT}-web:rollback" >/dev/null 2>&1 &&
    docker image inspect "${PROJECT}-cms:rollback" >/dev/null 2>&1; then
    ROLLBACK_REF="rollback"
    ROLLBACK_ORIGIN=":rollback (only one of web and cms ran before this deploy)"
  fi
  if [[ "${ROLLBACK_REF}" == "rollback" ]] && ! ((DRY_RUN)) && ! write_bootstrap; then
    echo "ERROR: could not write ${BOOTSTRAP_FILE}; nothing was built. Without it, a re-run after a" >&2
    echo "       deploy that failed after \`up\` would tag the failed images :rollback. The running" >&2
    echo "       containers are untouched. Fix the cause (free space, the permissions of ${STATE_DIR})" >&2
    echo "       and re-run." >&2
    exit 1
  fi
}

# Step 2 without a usable state: a running web or cms image that cannot be
# resolved or tagged leaves no whole :rollback target, so the run stops
# before the build (a dry run says it would). $@ = "<svc> <image id>".
refuse_rollback_target() {
  local entry prefix="ERROR:"
  if ((DRY_RUN)); then prefix="WOULD STOP:"; fi
  local svc
  for entry in "$@"; do
    svc="${entry%% *}"
    echo "${prefix} ${PROJECT}-${svc}-1 runs ${entry#* }, which no tag names any more: on the containerd" >&2
    echo "       image store it cannot be tagged ${PROJECT}-${svc}:rollback. Without a last-known-good state" >&2
    echo "       :rollback is the rollback target, so a failed deploy would have no rollback for ${svc} (only an" >&2
    echo "       older ${PROJECT}-${svc}:rollback, or none, next to the other service's current image: never mix" >&2
    echo "       releases)." >&2
  done
  echo "       Nothing was built; the running containers are untouched. Run that service from an image" >&2
  echo "       that has a tag, its current :latest (check that it is the release to roll back to), then re-run:" >&2
  for entry in "$@"; do
    echo "                      ${COMPOSE[*]} up -d --no-build --force-recreate ${entry%% *}" >&2
  done
  exit 1
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
      if docker image inspect "${img}" >/dev/null 2>&1; then
        echo "  would tag ${container} (${img}) as ${PROJECT}-${svc}:pre-deploy (keeps it resolvable through the build)"
      else
        echo "WARNING: would not be able to tag ${img} (${container}) as ${PROJECT}-${svc}:pre-deploy; it cannot be resolved here any more." >&2
      fi
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
        [[ -z "${PULLED_DIGESTS:-}" ]] || echo "PULLED=${PULLED_DIGESTS}"
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

# DEPLOY_IMAGE_SOURCE=registry: pulls the release's web and cms images, both
# before any local tag moves, refuses them unless their labels name this
# commit and version (a moved or foreign tag), then tags them as the images
# compose runs (<project>-web, <project>-cms). No fallback to a build.
# PULLED_DIGESTS: what was pulled, for the state.
pull_release_images() {
  local app ref labels
  PULLED_DIGESTS=""
  for app in web cms; do
    docker pull "${IMAGE_REPO}-${app}:${RELEASE_VERSION}"
  done
  for app in web cms; do
    ref="${IMAGE_REPO}-${app}:${RELEASE_VERSION}"
    labels="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.version"}}' "${ref}")"
    if [[ "${labels}" != "${HEAD_SHA} ${RELEASE_VERSION}" ]]; then
      echo "ERROR: ${ref} is labelled revision/version '${labels}', not ${HEAD_SHA} ${RELEASE_VERSION}:" >&2
      echo "       not the image of this checkout. Nothing was tagged." >&2
      return 1
    fi
    PULLED_DIGESTS+="${PULLED_DIGESTS:+ }$(docker image inspect --format '{{index .RepoDigests 0}}' "${ref}")"
  done
  for app in web cms; do
    docker tag "${IMAGE_REPO}-${app}:${RELEASE_VERSION}" "${PROJECT}-${app}:latest"
  done
  echo "  pulled: ${PULLED_DIGESTS}"
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
# The check runs of a GitHub check-runs answer (stdin), one line each:
# name, status, conclusion and the app's slug, separated by \037 (a null is
# empty). A small JSON scanner in POSIX awk (no jq): it follows strings,
# escapes and nesting, so a value anywhere else in a run (its output text,
# its app's name) never counts as the run's own.
check_runs_of() {
  awk '
    function flush() {
      if (tok != "") { put(tok == "null" ? "" : tok); tok = "" }
    }
    function put(v) {
      if (!run) return
      if (depth == 3) {
        if (key[3] == "name") rname = v
        else if (key[3] == "status") rstatus = v
        else if (key[3] == "conclusion") rconclusion = v
      } else if (depth == 4 && within[4] == "app" && key[4] == "slug") rslug = v
    }
    { body = body $0 "\n" }
    END {
      n = length(body)
      for (i = 1; i <= n; i++) {
        c = substr(body, i, 1)
        if (instr) {
          if (esc) { s = s c; esc = 0 }
          else if (c == "\\") esc = 1
          else if (c == "\"") {
            instr = 0
            if (wantkey) { key[depth] = s; wantkey = 0 } else put(s)
          } else s = s c
          continue
        }
        if (c == "\"") { instr = 1; s = ""; continue }
        if (c == "{" || c == "[") {
          depth++
          kind[depth] = c
          within[depth] = (kind[depth - 1] == "{") ? key[depth - 1] : ""
          key[depth] = ""
          wantkey = (c == "{")
          if (depth == 3 && c == "{" && kind[2] == "[" && within[2] == "check_runs") {
            run = 1; rname = ""; rstatus = ""; rconclusion = ""; rslug = ""
          }
          continue
        }
        if (c == "}" || c == "]") {
          flush()
          if (depth == 3 && run) {
            printf "%s\037%s\037%s\037%s\n", rname, rstatus, rconclusion, rslug
            run = 0
          }
          depth--
          wantkey = 0
          continue
        }
        if (c == ",") { flush(); if (kind[depth] == "{") wantkey = 1; continue }
        if (c == ":" || c == " " || c == "\t" || c == "\r" || c == "\n") { flush(); continue }
        tok = tok c
      }
    }
  '
}

# GitHub's check runs for HEAD, read without gh or jq. Prints one of: green,
# pending, failed, unknown — followed by a reason. Never fails. Only our CI
# counts: GitHub also attaches Dependabot's own update jobs to the default
# branch's HEAD (runs named "Dependabot" of the app github-actions, and the
# app dependabot's ".github/dependabot.yml"), which say nothing about this
# commit and may still run long after CI passed.
ci_status() {
  local remote slug body total runs name status conclusion app note=""
  local ours=0 ignored=0 unfinished=0 failing=0
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
    return 0
  fi
  runs="$(check_runs_of <<<"${body}")"
  while IFS=$'\037' read -r name status conclusion app; do
    [[ -n "${name}${status}${conclusion}${app}" ]] || continue
    if [[ "${name}" == "Dependabot" || "${app}" == "dependabot" ]]; then
      ignored=$((ignored + 1))
      continue
    fi
    ours=$((ours + 1))
    case "${status}" in
      queued | in_progress | waiting | requested | pending) unfinished=$((unfinished + 1)) ;;
    esac
    case "${conclusion}" in
      failure | cancelled | timed_out | action_required | startup_failure | stale) failing=$((failing + 1)) ;;
    esac
  done <<<"${runs}"
  if ((ignored)); then note=" (${ignored} Dependabot run(s) ignored)"; fi
  if ((ours == 0 && ignored == 0)); then
    echo "unknown: the GitHub answer lists ${total} check run(s) for ${HEAD_SHA:0:12}, but none could be read"
  elif ((ours == 0)); then
    echo "unknown: no CI run for ${HEAD_SHA:0:12} on ${slug}${note} (CI has not started)"
  elif ((unfinished)); then
    echo "pending: CI is still running for ${HEAD_SHA:0:12}${note}"
  elif ((failing)); then
    echo "failed: CI did not pass for ${HEAD_SHA:0:12}${note} (https://github.com/${slug}/commit/${HEAD_SHA}/checks)"
  else
    echo "green: ${ours} CI check(s) passed for ${HEAD_SHA:0:12}${note}"
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
oidc_invalid_keys="$(keys_of oidc-invalid)"
meili_invalid_keys="$(keys_of meili-invalid)"
boot_invalid_keys="$(keys_of boot-invalid)"
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
  echo "       (docs/SSO.md, \"Microsoft Entra ID sign-in\"). Or unset ENTRA_ENABLED." >&2
  preflight_failed=1
fi
# v0.25.0: the same for OIDC_ENABLED=1 (cms register(), web first request).
if [[ -n "${oidc_invalid_keys}" ]]; then
  echo "ERROR: OIDC_ENABLED=1, but these OIDC settings in infra/.env are invalid: ${oidc_invalid_keys}" >&2
  echo "       The cms and the web refuse to start with them. OIDC_ISSUER must be the https URL exactly as" >&2
  echo "       the identity provider's discovery document writes it, at most 255 characters (http only with" >&2
  echo "       OIDC_ALLOW_HTTP=1, never in production), OIDC_CLIENT_ID and OIDC_CLIENT_SECRET set," >&2
  echo "       OIDC_EXCHANGE_SECRET 32+ characters (openssl rand -hex 32), OIDC_DEFAULT_ROLE member|guest|deny," >&2
  echo "       OIDC_SESSION_TTL <n>m|h|d up to 7d, OIDC_ZITADEL_ORG_ID digits (required with a urn:zitadel:" >&2
  echo "       OIDC_ROLES_CLAIM), claim names or dotted paths in OIDC_ROLES_CLAIM and OIDC_DEPARTMENT_CLAIM," >&2
  echo "       OIDC_SCOPE with openid, OIDC_DISPLAY_NAME up to 40 characters, and never" >&2
  echo "       next to ENTRA_ENABLED=1 (docs/SSO.md, \"OIDC sign-in (Keycloak, authentik, Zitadel)\")." >&2
  echo "       Or unset OIDC_ENABLED." >&2
  preflight_failed=1
fi
# v0.21: the optional Meilisearch. With the profile on and no usable master
# key the meili container restarts forever; MEILISEARCH_ENABLED=1 without
# the profile or a key leaves the search on its fallback with a broken
# indexer. Refused here instead.
if [[ -n "${meili_invalid_keys}" ]]; then
  echo "ERROR: Meilisearch settings in infra/.env are missing or invalid: ${meili_invalid_keys}" >&2
  echo "       MEILISEARCH_ENABLED=1 needs COMPOSE_PROFILES=search, MEILI_MASTER_KEY (16+ characters," >&2
  echo "       openssl rand -hex 32), MEILISEARCH_WRITE_KEY and MEILISEARCH_SEARCH_KEY (printed by" >&2
  echo "       infra/meilisearch/provision-keys.sh) and a MEILISEARCH_URL; the search profile alone" >&2
  echo "       needs the master key. docs/OPERATIONS.md, \"Meilisearch (optional search)\"." >&2
  echo "       Or unset MEILISEARCH_ENABLED and COMPOSE_PROFILES." >&2
  preflight_failed=1
fi
if [[ -n "${boot_invalid_keys}" ]]; then
  echo "ERROR: the cms would refuse to boot with these settings in infra/.env: ${boot_invalid_keys}" >&2
  echo "       TRAINING_EVIDENCE_RETENTION_YEARS: a whole number of years, 1 to 30 (unset: 3)." >&2
  echo "       SEARCH_LOG_RETENTION_DAYS: a whole number of days, 1 to 3650 (unset: 90)." >&2
  echo "       FEATURES_OFF: a comma list of events, training, marketplace, kudos, celebrations, polls," >&2
  echo "       duty-plans, kpis, read-confirmations, training-reports, search-logging." >&2
  preflight_failed=1
fi
# 5A-T1: the host the edge serves: with Traefik the host every router
# matches (the rendered labels), with Caddy its site address DOMAIN.
if [[ "${DEPLOY_EDGE}" == traefik ]]; then
  edge_scan="$("${COMPOSE[@]}" config --format json 2>/dev/null | traefik_host_scan)"
else
  edge_scan="$("${COMPOSE[@]}" config --format json 2>/dev/null | caddy_host_scan)"
fi
EDGE_HOST="$(sed -n 's/^host //p' <<<"${edge_scan}")"
EDGE_ORIGIN="$(sed -n 's/^origin //p' <<<"${edge_scan}")"
edge_problems="$(sed -n 's/^problem //p' <<<"${edge_scan}")"
if [[ -n "${edge_problems}" ]]; then
  echo "ERROR: DOMAIN in infra/.env does not fit this instance:" >&2
  while IFS= read -r problem; do echo "       - ${problem}" >&2; done <<<"${edge_problems}"
  if [[ "${DEPLOY_EDGE}" == traefik ]]; then
    echo "       Every Traefik router matches Host(\`\$DOMAIN\`), and web and cms are served on that one host:" >&2
  else
    echo "       The bundled Caddy serves web and cms on DOMAIN, that one host:" >&2
  fi
  echo "       with this value the site would answer 404 or break sign-in, and an image rollback would not" >&2
  echo "       help. Set DOMAIN to the public host name, the host of WEB_PUBLIC_URL and CMS_PUBLIC_URL" >&2
  echo "       (docs/INSTALL.md, \"Behind your own Traefik\"), and re-run." >&2
  preflight_failed=1
fi
# The Caddy edge next to a host Traefik: the bundled Caddy would claim
# 80/443, and the Traefik routers of the running containers would go. A
# stopped container counts: its labels say which edge this host runs.
# A failed listing proves nothing: refused too.
if [[ "${DEPLOY_EDGE}" != traefik ]]; then
  if ! traefik_labelled="$(docker ps -aq --filter label=traefik.enable=true --filter "label=com.docker.compose.project=${PROJECT}")"; then
    echo "ERROR: docker ps failed, so deploy.sh cannot tell whether this host runs a Traefik edge (DEPLOY_EDGE is" >&2
    echo "       ${DEPLOY_EDGE}). Run it as a user with access to Docker, and re-run." >&2
    preflight_failed=1
  elif [[ -n "${traefik_labelled}" ]]; then
    echo "ERROR: containers of compose project ${PROJECT} carry Traefik labels, so this host runs a Traefik edge," >&2
    echo "       and DEPLOY_EDGE is ${DEPLOY_EDGE}: the bundled Caddy would claim ports 80/443 next to it." >&2
    echo "       Set DEPLOY_EDGE=traefik in infra/deploy.env (infra/deploy.env.example) and re-run." >&2
    preflight_failed=1
  fi
fi
# v0.29: the legacy-zone overrides of releases before v0.25 are gone. A
# container of the project (running or stopped) started with one runs a
# setup below the upgrade floor, or was left with an override this deploy
# would drop: refused, naming the way out. A failed listing proves nothing.
if ! compose_files="$(docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.Label "com.docker.compose.project.config_files"}}')"; then
  echo "ERROR: docker ps failed, so deploy.sh cannot tell which compose files the containers of project" >&2
  echo "       ${PROJECT} were started with. Run it as a user with access to Docker, and re-run." >&2
  preflight_failed=1
elif retired="$(grep -oE 'docker-compose\.(cms|web)-legacy-tz\.yml' <<<"${compose_files}" | sort -u | tr '\n' ' ')" &&
  [[ -n "${retired}" ]]; then
  echo "ERROR: containers of compose project ${PROJECT} were started with ${retired}(the legacy-zone" >&2
  echo "       overrides of releases before v0.25, gone since v0.29). If they run a release before v0.25," >&2
  echo "       upgrade through v0.28.x first (docs/UPGRADE.md). Otherwise recreate them with the supported" >&2
  echo "       compose files, then re-run:" >&2
  echo "                      ${COMPOSE[*]} up -d --no-build --force-recreate web cms" >&2
  preflight_failed=1
fi
if "${COMPOSE[@]}" config --format json 2>/dev/null | site_closed; then
  echo "ERROR: the site is closed (SITE_ALLOW_CIDRS); open it before deploying." >&2
  echo "       A deploy is no step of the restricted restore (docs/OPERATIONS.md, \"Restore\"): its smoke" >&2
  echo "       checks would get 503 from this host. Finish the restore, remove SITE_ALLOW_CIDRS from" >&2
  echo "       infra/.env, recreate the edge (Caddy) or the apps (Traefik), and re-run." >&2
  preflight_failed=1
fi
if checkout_revisions_dp_off; then
  REVISION_DRAFTS="$(revision_draft_rows "${PROBE_TIMEOUT[@]}" || true)"
  if [[ "${REVISION_DRAFTS}" =~ ^[0-9]+$ && "${REVISION_DRAFTS}" -gt 0 ]]; then
    echo "ERROR: the running database holds ${REVISION_DRAFTS} wiki revision draft row(s), and this release runs" >&2
    echo "       wiki revisions without draft & publish: the new cms refuses to start on them (a rollback to a" >&2
    echo "       release before batch 16 cloned a draft twin of every revision). With cms and web stopped and" >&2
    echo "       after a backup, run the read-only preflight, then the migration as one transaction:" >&2
    echo "                      ${COMPOSE[*]} exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"' < ${INFRA_DIR}/migrations/wiki-revision-dp/preflight.sql" >&2
    echo "                      ${COMPOSE[*]} exec -T db sh -c 'psql -X -v ON_ERROR_STOP=1 --single-transaction -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\"' < ${INFRA_DIR}/migrations/wiki-revision-dp/migrate.sql" >&2
    echo "       (${REVISION_DP_RUNBOOK}), then re-run." >&2
    preflight_failed=1
  elif [[ "${REVISION_DRAFTS}" =~ ^[0-9]+$ ]]; then
    echo "  wiki revisions: no draft rows"
  else
    echo "  wiki revisions: not checked (no database to ask); the new cms checks at its start"
  fi
fi
if ((preflight_failed)); then
  echo "Preflight failed. Nothing was changed." >&2
  exit 1
fi
log "Preflight OK"
# The smoke checks follow the host the edge serves (checked above).
if [[ "${DEPLOY_EDGE}" == traefik ]]; then
  SMOKE_URL="${SMOKE_URL:-https://${EDGE_HOST}}"
  echo "  Traefik host: ${EDGE_HOST}; smoke URL: ${SMOKE_URL}"
else
  SMOKE_URL="${SMOKE_URL:-${EDGE_ORIGIN}}"
  echo "  Caddy host: ${EDGE_HOST}; smoke URL: ${SMOKE_URL}"
fi
if ((CHECK_ONLY)); then
  echo "  --check: nothing deployed."
  exit 0
fi

# How step 4 runs infra/live-smoke.sh: "run …" or "skip: <reason>". The
# switches come from the env compose hands the apps (compose_env_value),
# read as the apps read them: LIVE_EVENTS_DISABLED exactly 1 (web
# lib/live-bus.ts, cms utils/live-events.ts); identity provider only =
# ENTRA_ENABLED or OIDC_ENABLED exactly 1 without AUTH_LOCAL_ENABLED=1 (web
# lib/auth-config.ts localSignInEnabled), where live-smoke needs no demo
# credentials (it skips the sign-in steps itself).
live_smoke_mode() {
  local json live_disabled entra oidc local_signin
  # One compose call; the JSON (secrets included) stays in this function
  # and reaches awk through a pipe, never a file or the terminal.
  json="$("${COMPOSE[@]}" config --format json 2>/dev/null || true)"
  live_disabled="$(printf '%s\n' "${json}" | compose_env_value LIVE_EVENTS_DISABLED)"
  entra="$(printf '%s\n' "${json}" | compose_env_value ENTRA_ENABLED)"
  oidc="$(printf '%s\n' "${json}" | compose_env_value OIDC_ENABLED)"
  local_signin="$(printf '%s\n' "${json}" | compose_env_value AUTH_LOCAL_ENABLED)"
  if [[ "${live_disabled}" == "1" ]]; then
    echo "skip: LIVE_EVENTS_DISABLED=1 (the apps run on the polling fallback)"
  elif [[ ("${entra}" == "1" || "${oidc}" == "1") && "${local_signin}" != "1" ]]; then
    echo "run (identity provider only: the datetime check, then it skips the sign-in steps)"
  elif [[ (-n "${PASSWORDS_FILE}" && -r "${PASSWORDS_FILE}") || (-n "${SMOKE_PASSWORD:-}" && -n "${SMOKE_AUTHOR_PASSWORD:-}") ]]; then
    echo "run"
  elif [[ -n "${PASSWORDS_FILE}" ]]; then
    echo "skip: demo credentials file ${PASSWORDS_FILE} not readable — run infra/live-smoke.sh manually"
  else
    echo "skip: demo credentials not configured (PASSWORDS_FILE, or SMOKE_PASSWORD and SMOKE_AUTHOR_PASSWORD) — run infra/live-smoke.sh manually"
  fi
}

# True (0) when LIVE_SMOKE_MODE says live-smoke does not run for want of the
# demo credentials (a typo in PASSWORDS_FILE, the wrong user) and
# --record-without-live-smoke was not given: step 5 then records nothing,
# as the SSE pipeline went unverified. LIVE_EVENTS_DISABLED=1 (SSE off on
# purpose) and an identity-provider-only instance (Entra or OIDC without
# AUTH_LOCAL_ENABLED=1: the datetime check alone) record.
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
    echo "       Nothing was changed (docs/INSTALL.md, \"Behind your own Traefik\", the parameters)." >&2
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
# The common git dir of the clone (its .git, also from a linked worktree),
# so every worktree of it shares state, history and lock. A second clone
# that deploys the same project must set DEPLOY_STATE_DIR to the same
# directory. (Not named GIT_DIR: git itself reads that variable.)
REPO_GIT_DIR="$("${GIT[@]}" rev-parse --git-common-dir)"
if [[ "${REPO_GIT_DIR}" != /* && "${REPO_GIT_DIR}" != [A-Za-z]:* ]]; then
  REPO_GIT_DIR="${CHECKOUT}/${REPO_GIT_DIR}"
fi
REPO_GIT_DIR="$(cd "${REPO_GIT_DIR}" && pwd)"
STATE_DIR="${DEPLOY_STATE_DIR:-${REPO_GIT_DIR}/sinnlos-deploy}"
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
      echo "ERROR: another infra/deploy.sh (or an infra/restore-db.sh step) is running for compose project ${PROJECT} (lock ${LOCK_FILE})." >&2
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
    echo "ERROR: another infra/deploy.sh (or an infra/restore-db.sh step) is running for compose project ${PROJECT} (lock ${LOCK_FILE})." >&2
    echo "       Nothing was changed. Let it finish, then re-run." >&2
    exit 1
  fi
  echo "  lock: ${LOCK_FILE}"
fi

# A database restore in progress (infra/restore-db.sh prepare, until its
# start passed or cancel) reserves the project: a deploy now would start the
# cms on a database that may be empty, or restored without its new
# JWT_SECRET. Checked under the lock, which every restore step holds too;
# it lies next to the lock (restore-db.sh keeps its state there), so a clone
# that shares DEPLOY_STATE_DIR sees the other's restore.
RESTORE_RESERVATION="${STATE_DIR}/restore/${PROJECT}.reservation"
if [[ -e "${RESTORE_RESERVATION}" || -L "${RESTORE_RESERVATION}" ]]; then
  echo "ERROR: a database restore of compose project ${PROJECT} is in progress (${RESTORE_RESERVATION})." >&2
  echo "       infra/restore-db.sh status shows it: finish it (apply, rotate-jwt, start), or end it with" >&2
  echo "       infra/restore-db.sh cancel (only before its apply). Nothing was changed." >&2
  exit 1
fi
echo "  restore reservation: none"

# The images must be exactly the commit their tag names. GIT_OPTIONAL_LOCKS=0
# keeps `git status` from refreshing the index (a dry run writes nothing).
DIRTY="$(GIT_OPTIONAL_LOCKS=0 "${GIT[@]}" status --porcelain --untracked-files=no)"
if [[ -n "${DIRTY}" ]]; then
  echo "ERROR: the checkout ${CHECKOUT} has changed tracked files; the images would not be commit ${NEW_TAG}:" >&2
  head -n 20 <<<"${DIRTY}" | sed 's/^/         /' >&2
  echo "       Commit, stash or revert them (git -C ${CHECKOUT} status), then re-run. Nothing was changed." >&2
  exit 1
fi
# The Dockerfiles copy apps/cms, apps/web and packages/domain whole, and the
# root manifests; .dockerignore drops only build output, local state and
# caches, and .env files. An untracked file there would be built into images
# tagged as this commit, and so would an untracked directory, even an empty
# one, which `git status` never lists: an empty apps/web/app/ makes Next.js
# build that (empty) app directory instead of src/app (seen in the lane
# rehearsal: every page answered 500).
# `git clean -n -d` (a dry run: it lists, never removes) names both, and
# skips ignored files.
BUILD_CONTEXT_PATHS=(apps/cms apps/web packages package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json)
UNTRACKED_IN_BUILD="$("${GIT[@]}" clean -n -d -- "${BUILD_CONTEXT_PATHS[@]}" | sed -n 's/^Would remove //p')"
if [[ -n "${UNTRACKED_IN_BUILD}" ]]; then
  echo "ERROR: the checkout ${CHECKOUT} has untracked files or directories where the web and cms images are" >&2
  echo "       built from; the images would not be commit ${NEW_TAG}:" >&2
  head -n 20 <<<"${UNTRACKED_IN_BUILD}" | sed 's/^/         /' >&2
  echo "       Commit, move or delete them (git -C ${CHECKOUT} clean -n -d lists them), then re-run. Nothing" >&2
  echo "       was changed." >&2
  exit 1
fi
UNTRACKED="$(GIT_OPTIONAL_LOCKS=0 "${GIT[@]}" status --porcelain --untracked-files=normal | sed -n 's/^?? //p')"
if [[ -n "${UNTRACKED}" ]]; then
  echo "  NOTE: untracked files in the checkout, outside what the web and cms images are built from:"
  head -n 10 <<<"${UNTRACKED}" | sed 's/^/        /'
fi
echo "  checkout: ${CHECKOUT} at ${NEW_TAG} ($("${GIT[@]}" log -1 --format=%s HEAD)), clean"

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

# Registry images: the checkout's one release tag names them, and it must be
# the version package.json carries (the images' labels are checked after the
# pull, step 3).
if [[ "${DEPLOY_IMAGE_SOURCE}" == registry ]]; then
  RELEASE_TAGS="$("${GIT[@]}" tag --points-at HEAD --list 'v*')"
  PACKAGE_VERSION="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "${CHECKOUT}/package.json" 2>/dev/null || true)"
  if [[ -z "${RELEASE_TAGS}" || "${RELEASE_TAGS}" == *$'\n'* || "${RELEASE_TAGS#v}" != "${PACKAGE_VERSION}" ]]; then
    echo "ERROR: DEPLOY_IMAGE_SOURCE=registry needs exactly one release tag v<version> on ${NEW_TAG}, the version of" >&2
    echo "       package.json (${PACKAGE_VERSION:-none}); found: $(tr '\n' ' ' <<<"${RELEASE_TAGS:-none}")" >&2
    echo "       Check out a release tag (git checkout v<version>), or build: DEPLOY_IMAGE_SOURCE=build. Nothing was changed." >&2
    exit 1
  fi
  RELEASE_VERSION="${PACKAGE_VERSION}"
  echo "  release: v${RELEASE_VERSION} (${IMAGE_REPO}-{web,cms}:${RELEASE_VERSION})"
fi

if ((DRY_RUN)); then
  log "Dry run: the plan (nothing is changed)"
  if [[ "${PROJECT}" == "infra" && -n "${BACKUP_RUN}" ]]; then
    echo "  1. pre-deploy backup: ${BACKUP_RUN_CMD[*]} (none on a first install)"
  else
    echo "  1. pre-deploy backup: SINNLOS_BACKUP_KIND=predeploy ${BACKUP_SCRIPT} (none on a first install)"
  fi
  echo "  2. rollback target:"
  keep_running_images
  resolve_rollback_target
  echo "     -> ${ROLLBACK_ORIGIN:-none: nothing ran here before (first install)}"
  if [[ "${DEPLOY_IMAGE_SOURCE}" == registry ]]; then
    echo "  3. docker pull ${IMAGE_REPO}-{web,cms}:${RELEASE_VERSION}, check their labels, tag them ${PROJECT}-{web,cms}, then ${COMPOSE[*]} up -d --no-build"
  else
    echo "  3. SINNLOS_VERSION=<package.json> SINNLOS_REVISION=${NEW_TAG} BUILDX_NO_DEFAULT_ATTESTATIONS=1 ${COMPOSE[*]} build, then ${COMPOSE[*]} up -d --no-build"
  fi
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
elif [[ "${PROJECT}" == "infra" && -n "${BACKUP_RUN}" ]]; then
  # The host's backup service (the owner's: backup-run's service sinnlos,
  # infra-db-1, infra_cms_uploads, infra/.env; the SINNLOS_* overrides above
  # do not apply). It waits for a running nightly backup (its lock). Any
  # failure, a missing sudoers drop-in included (sudo -n then refuses),
  # stops the deploy here through the ERR trap, before the containers are
  # touched.
  echo "  ${BACKUP_RUN_CMD[*]}"
  "${BACKUP_RUN_CMD[@]}"
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
if [[ "${DEPLOY_IMAGE_SOURCE}" == registry ]]; then
  pull_release_images
else
  # Without BuildKit's default provenance attestation every build is a new
  # image index, also for unchanged content: :latest would move although
  # nothing changed (and, on the containerd image store, leave the running
  # image without a name; keep_running_images covers that as well).
  # The images' version and revision labels (compose build args): the
  # checkout's package.json version and commit.
  SINNLOS_VERSION="$(sed -n 's/^  "version": "\([^"]*\)",$/\1/p' "${CHECKOUT}/package.json" 2>/dev/null || true)"
  export SINNLOS_VERSION="${SINNLOS_VERSION:-unknown}" SINNLOS_REVISION="${NEW_TAG}"
  BUILDX_NO_DEFAULT_ATTESTATIONS=1 "${COMPOSE[@]}" build
fi
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
location=
smoke_ok=0
for ((i = 1; i <= attempts; i++)); do
  # curl writes 000 itself when there is no answer.
  answer="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 "${SMOKE_URL}")" || true
  code="${answer%% *}"
  code="${code:-000}"
  location="${answer#"${code}"}"
  location="${location# }"
  # A redirect counts only when it goes to the web's sign-in page: Traefik's
  # own redirects (http to https) and a wrong path prove nothing about the web.
  if [[ "${code}" == 200 || ("${code}" =~ ^30[1278]$ && "${location}" =~ ^https?://[^/]+/sign-in([?#].*)?$) ]]; then
    smoke_ok=1
    break
  fi
  if ((i < attempts)); then
    echo "  attempt ${i}/${attempts}: HTTP ${code} — retrying in ${delay}s"
    sleep "${delay}"
  fi
done
if ! ((smoke_ok)); then
  echo "ERROR: smoke check failed — ${SMOKE_URL} returned HTTP ${code}${location:+ to ${location}}" >&2
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
  if [[ "${LIVE_SMOKE_MODE}" == "run (identity provider only"* ]]; then
    LIVE_SMOKE_RESULT="passed: the datetime check only (identity-provider-only instance)"
  elif grep -q 'the notification frame path was not checked' "${LIVE_SMOKE_OUT}"; then
    LIVE_SMOKE_RESULT="passed (notification frame not checked)"
    echo "WARNING: live-smoke did not check the notification frame path: the stream user has no announcement" >&2
    echo "         of their own. Give ${PASSWORDS_FILE} a line for an announcement author, or set SMOKE_EMAIL" >&2
    echo "         (docs/INSTALL.md, \"9. Upgrades\", live-smoke)." >&2
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
