#!/usr/bin/env bash
#
# deploy.sh — direct deploy for the 'sinnlos' intranet (docker compose project 'infra').
#
# What it does, in order:
#   0. Preflight of infra/.env against the env contract (FX13): required
#      keys set, no template placeholder in the secrets, digest sender set
#      when SMTP is, JWT_SECRET rotated when the running web still exposed
#      Strapi JWTs (D-SESSION-01), no Microsoft sign-in configured (it
#      cannot complete on Strapi 5.51+). Fails before anything is touched.
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
# a value: "fatal KEY", "warn KEY", "digest KEY" (SMTP set, but the digest
# gate in apps/cms/src/digest/send-digests.ts would skip every run),
# "entra MS_CLIENT_ID" (the web offers Microsoft sign-in with a real app
# registration, a GUID client id) or "entra-template MS_CLIENT_ID" (the same
# with a non-GUID value, e.g. the .env.example text).
# The key lists, the markers, the digest rule and the Microsoft rule are
# pinned against env-guard.ts, send-digests.ts and the web's auth-config.ts
# by apps/cms/src/utils/deploy-preflight.test.ts.
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
      # The web offers Microsoft sign-in whenever both of its Entra keys are
      # non-empty (MICROSOFT_ENABLED in apps/web/src/lib/auth-config.ts;
      # compose fills them from MS_CLIENT_ID / MS_CLIENT_SECRET).
      if (env["AUTH_MICROSOFT_ENTRA_ID_ID"] != "" && env["AUTH_MICROSOFT_ENTRA_ID_SECRET"] != "") {
        if (guid(env["AUTH_MICROSOFT_ENTRA_ID_ID"])) print "entra MS_CLIENT_ID"
        else print "entra-template MS_CLIENT_ID"
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
entra_keys="$(keys_of entra)"
entra_template_keys="$(keys_of entra-template)"
if [[ -n "${entra_template_keys}" ]]; then
  echo "WARNING: MS_CLIENT_ID/MS_CLIENT_SECRET are set, but MS_CLIENT_ID is no GUID (template text?)." >&2
  echo "         The sign-in page offers a Microsoft button that cannot work, and local sign-in" >&2
  echo "         is off unless AUTH_LOCAL_ENABLED=1. Clear both in infra/.env for local sign-in." >&2
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
# Strapi 5.51+ completes /api/auth/:provider/callback only from its own OAuth
# session, so it answers the web's server-side access-token exchange
# (apps/web/src/auth.ts) with a 400: every Microsoft sign-in fails, and an
# install without AUTH_LOCAL_ENABLED=1 has no working sign-in at all.
# Remove this gate together with that exchange (D-ENTRA-01).
if [[ -n "${entra_keys}" ]]; then
  echo "ERROR: Microsoft sign-in is configured (MS_CLIENT_ID/MS_CLIENT_SECRET), but it cannot" >&2
  echo "       work with this release: Strapi 5.51+ no longer accepts the web's access-token" >&2
  echo "       exchange, so every Microsoft sign-in fails (and with AUTH_LOCAL_ENABLED=0 nobody" >&2
  echo "       can sign in). Keep the running release until the Entra exchange ships, or clear" >&2
  echo "       MS_CLIENT_ID and MS_CLIENT_SECRET in infra/.env to run with local sign-in only" >&2
  echo "       (accounts created through Microsoft sign-in have no local password)." >&2
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
if ((preflight_failed)); then
  echo "Preflight failed. Nothing was changed." >&2
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
