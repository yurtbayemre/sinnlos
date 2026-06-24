#!/usr/bin/env bash
#
# deploy.sh — direct deploy for the 'sinnlos' intranet (docker compose project 'infra').
#
# What it does, in order:
#   1. Pre-deploy Postgres backup (infra/backup/pg-backup.sh).
#   2. Rollback-tag the currently running web/cms images as :rollback so a
#      failed deploy can be reverted by retagging :rollback back to :latest.
#   3. Rebuild + restart the stack with the Traefik override.
#   4. Curl smoke-check of the live site.
#
# Re-run safe. Stops on the first error (set -euo pipefail).
#
# Usage:
#   infra/deploy.sh
#
set -euo pipefail

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
#   docker tag infra-web:rollback infra-web:latest && <re-up just that service>
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
    log "Deploy complete."
    exit 0
  fi
  echo "  attempt ${i}/${attempts}: HTTP ${code} — retrying in ${delay}s"
  sleep "${delay}"
done

echo "ERROR: smoke check failed — ${SMOKE_URL} returned HTTP ${code}" >&2
echo "       Inspect logs:  ${COMPOSE[*]} logs --tail=100 web cms" >&2
echo "       To roll back:  docker tag ${PROJECT}-web:rollback ${PROJECT}-web:latest (and cms), then re-up." >&2
exit 1
