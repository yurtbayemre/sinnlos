#!/usr/bin/env bash
#
# deploy.sh — direct deploy for the 'sinnlos' intranet (docker compose project 'infra').
#
# What it does, in order:
#   0. Preflight of infra/.env against the env contract (FX13): required
#      keys set, no template placeholder in the secrets. Fails before
#      anything is touched.
#   1. Pre-deploy Postgres backup (infra/backup/pg-backup.sh).
#   2. Rollback-tag the currently running web/cms images as :rollback so a
#      failed deploy can be reverted by retagging :rollback back to :latest.
#   3. Rebuild + restart the stack with the Traefik override.
#   4. Curl smoke-check of the live site.
#
# Re-run safe. Stops on the first error (set -euo pipefail).
#
# Usage:
#   infra/deploy.sh           # preflight + full deploy
#   infra/deploy.sh --check   # preflight only (validate infra/.env), deploys nothing
#
set -euo pipefail

CHECK_ONLY=0
case "${1:-}" in
  "") ;;
  --check) CHECK_ONLY=1 ;;
  *)
    echo "usage: infra/deploy.sh [--check]" >&2
    exit 2
    ;;
esac

# --- Resolve paths (script lives in infra/) ---------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

COMPOSE_BASE="${SCRIPT_DIR}/docker-compose.yml"
COMPOSE_TRAEFIK="${SCRIPT_DIR}/docker-compose.traefik.yml"
BACKUP_SCRIPT="${SCRIPT_DIR}/backup/pg-backup.sh"

# Compose project name — must stay 'infra' so container/image names are stable
# (infra-web-1, infra-cms-1, infra-db-1 / images infra-web, infra-cms).
PROJECT="infra"
COMPOSE=(docker compose -p "${PROJECT}" -f "${COMPOSE_BASE}" -f "${COMPOSE_TRAEFIK}")

SMOKE_URL="${SMOKE_URL:-https://sinnlos.yurtbay.dev}"

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
# a value: "fatal KEY", "warn KEY" or "digest KEY" (SMTP set, but the digest
# gate in apps/cms/src/digest/send-digests.ts would skip every run).
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
      if (env["DIGESTS_DISABLED"] != "1" && env["SMTP_HOST"] != "" && env["SMTP_USER"] != "" && env["SMTP_PASS"] != "") {
        if (env["PUBLIC_WEB_URL"] ~ /^[ \t]*$/) print "digest PUBLIC_WEB_URL"
        if (env["DIGEST_FROM"] ~ /^[ \t]*$/) print "digest DIGEST_FROM"
      }
    }' | sort -u
}

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
if [[ -n "${warn_keys}" ]]; then
  echo "WARNING: template placeholder in: ${warn_keys}" >&2
  echo "         Rotate it (ALTER ROLE ... PASSWORD in Postgres first, then infra/.env);" >&2
  echo "         the cms only warns about it." >&2
fi
if [[ -n "${digest_keys}" ]]; then
  echo "WARNING: SMTP_* is set but these are empty: ${digest_keys}" >&2
  echo "         Every e-mail digest run will be skipped (FX13 removed the built-in sender" >&2
  echo "         and link defaults). Set them in infra/.env, e.g." >&2
  echo "         DIGEST_FROM='Intranet <noreply@your-domain>', or set DIGESTS_DISABLED=1." >&2
fi
if [[ -n "${fatal_keys}" ]]; then
  echo "ERROR: template placeholder in: ${fatal_keys}" >&2
  echo "       The cms refuses to start in production with a placeholder secret (and a" >&2
  echo "       placeholder AUTH_SECRET makes web sessions forgeable). Nothing was changed." >&2
  echo "       Generate real values (openssl rand -base64 32; -hex 32 for REVALIDATE_SECRET" >&2
  echo "       and INTERNAL_UPLOAD_TOKEN) and re-run. Rotating JWT_SECRET or AUTH_SECRET" >&2
  echo "       signs every user out once." >&2
  exit 1
fi
log "Preflight OK"
if ((CHECK_ONLY)); then
  echo "  --check: nothing deployed."
  exit 0
fi

# --- 1. Pre-deploy database backup ------------------------------------------
log "Pre-deploy database backup"
if [[ -x "${BACKUP_SCRIPT}" ]]; then
  "${BACKUP_SCRIPT}"
elif [[ -f "${BACKUP_SCRIPT}" ]]; then
  bash "${BACKUP_SCRIPT}"
else
  echo "ERROR: backup script not found at ${BACKUP_SCRIPT}" >&2
  echo "       (it is provisioned separately) — aborting deploy." >&2
  exit 1
fi

# --- 2. Rollback-tag the currently running images ---------------------------
# Capture the image each running container currently uses, then tag it
# :rollback. If a deploy goes bad you can revert with, e.g.:
#   docker tag infra-web:rollback infra-web:latest
#   docker compose -p infra -f ... up -d --no-build web
# The re-up MUST use --no-build: with --build compose would rebuild (and
# re-deploy) the broken image instead of starting the retagged one.
log "Tagging current images as :rollback"
for svc in web cms; do
  container="${PROJECT}-${svc}-1"
  if img="$(docker inspect --format '{{.Image}}' "${container}" 2>/dev/null)" && [[ -n "${img}" ]]; then
    docker tag "${img}" "${PROJECT}-${svc}:rollback"
    echo "  ${container} (${img}) -> ${PROJECT}-${svc}:rollback"
  else
    echo "  ${container} not running — nothing to roll back to (first deploy?)"
  fi
done

# --- 3. Build + restart -----------------------------------------------------
log "Building and starting the stack"
"${COMPOSE[@]}" up -d --build

# --- 4. Smoke check ---------------------------------------------------------
log "Smoke-checking ${SMOKE_URL}"
attempts=10
delay=6
code=000
for ((i = 1; i <= attempts; i++)); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "${SMOKE_URL}" || echo 000)"
  if [[ "${code}" =~ ^(200|301|302|307|308)$ ]]; then
    log "Smoke check OK (HTTP ${code} after ${i} attempt(s))"
    # --- 5. Live-pipeline smoke (issue #17/#27) ------------------------------
    # The SSE chain is fire-and-forget and can fail silently while every
    # container reports healthy — this probe is the only end-to-end proof.
    # Skipped (with a loud note) when the demo credentials file is absent
    # or the kill switch is on.
    if [[ "${LIVE_EVENTS_DISABLED:-0}" == "1" ]]; then
      log "live-smoke skipped: LIVE_EVENTS_DISABLED=1"
    elif [[ -r "${PASSWORDS_FILE:-/home/bigemo/.sinnlos-env-backup/demo-account-passwords.txt}" ]]; then
      log "Running live-pipeline smoke (infra/live-smoke.sh)"
      if ! "${SCRIPT_DIR}/live-smoke.sh"; then
        echo "ERROR: live-smoke failed — the SSE pipeline is NOT delivering pings." >&2
        echo "       App still works on polling fallback; investigate before calling this deploy done:" >&2
        echo "       docker logs ${PROJECT}-cms-1 2>&1 | grep live-emit ; docker logs ${PROJECT}-web-1 2>&1 | grep '\\[live\\]'" >&2
        exit 1
      fi
    else
      log "live-smoke SKIPPED: demo credentials file not readable — run infra/live-smoke.sh manually"
    fi
    log "Deploy complete."
    exit 0
  fi
  echo "  attempt ${i}/${attempts}: HTTP ${code} — retrying in ${delay}s"
  sleep "${delay}"
done

echo "ERROR: smoke check failed — ${SMOKE_URL} returned HTTP ${code}" >&2
echo "       Inspect logs:  ${COMPOSE[*]} logs --tail=100 web cms" >&2
echo "       To roll back:  docker tag ${PROJECT}-web:rollback ${PROJECT}-web:latest (and cms), then:" >&2
echo "                      ${COMPOSE[*]} up -d --no-build web cms" >&2
echo "       (--no-build is essential — --build would rebuild the broken image)" >&2
exit 1
