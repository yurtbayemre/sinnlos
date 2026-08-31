#!/usr/bin/env bash
#
# live-smoke.sh — end-to-end probe of the SSE live pipeline (issue #17/#27).
#
# The whole pipeline is fire-and-forget by design (CMS emit → web bus →
# SSE stream), so it can fail SILENTLY while every container looks healthy:
# streams open, heartbeats flow, but no ping ever arrives and the app
# quietly degrades to polling. This script is the guard against exactly
# that — run it after every deploy (deploy.sh calls it when creds exist).
#
# Chain under test:
#   1. Sign in to the web app as a demo user (Auth.js credentials flow)
#      and hold an open `curl -N` on /live/stream.
#   2. Log in to Strapi INSIDE the cms container (the edge routes
#      /api/auth/* to Next, so the Strapi JWT is only obtainable
#      internally) as a SECOND demo user and POST a comment.
#   3. Assert a `ping` frame for that channel arrives on the stream
#      within ASSERT_SECONDS.
#
# Usage:
#   SMOKE_EMAIL=casey.jones@sinnlos.local SMOKE_PASSWORD=… \
#   SMOKE_AUTHOR_EMAIL=sam.chen@sinnlos.local SMOKE_AUTHOR_PASSWORD=… \
#   infra/live-smoke.sh
#
# Password file fallback: PASSWORDS_FILE (default
# /home/bigemo/.sinnlos-env-backup/demo-account-passwords.txt, lines of
# "email@host password"; anchor greps with ^email@ — the header comment
# line matches un-anchored greps!).
#
# Notes:
#   - Watch the Strapi login rate limit (10 fails/60s per IP) when
#     iterating on this script.
#   - The comment targets the newest visible announcement of the AUTHOR
#     user; if none exists the script fails loudly (seeded prod has some).
#
set -euo pipefail

BASE_URL="${BASE_URL:-https://sinnlos.yurtbay.dev}"
CMS_CONTAINER="${CMS_CONTAINER:-infra-cms-1}"
ASSERT_SECONDS="${ASSERT_SECONDS:-5}"
PASSWORDS_FILE="${PASSWORDS_FILE:-/home/bigemo/.sinnlos-env-backup/demo-account-passwords.txt}"

SMOKE_EMAIL="${SMOKE_EMAIL:-casey.jones@sinnlos.local}"
SMOKE_AUTHOR_EMAIL="${SMOKE_AUTHOR_EMAIL:-sam.chen@sinnlos.local}"

lookup_password() {
  local email="$1"
  grep "^${email} " "${PASSWORDS_FILE}" | awk '{print $2}' | head -1
}

if [[ -z "${SMOKE_PASSWORD:-}" ]]; then
  SMOKE_PASSWORD="$(lookup_password "${SMOKE_EMAIL}")"
fi
if [[ -z "${SMOKE_AUTHOR_PASSWORD:-}" ]]; then
  SMOKE_AUTHOR_PASSWORD="$(lookup_password "${SMOKE_AUTHOR_EMAIL}")"
fi
if [[ -z "${SMOKE_PASSWORD}" || -z "${SMOKE_AUTHOR_PASSWORD}" ]]; then
  echo "live-smoke: FAIL — missing passwords (set SMOKE_PASSWORD/SMOKE_AUTHOR_PASSWORD or provide ${PASSWORDS_FILE})" >&2
  exit 1
fi

WORKDIR="$(mktemp -d)"
STREAM_LOG="${WORKDIR}/stream.log"
COOKIES="${WORKDIR}/cookies.txt"
cleanup() {
  [[ -n "${STREAM_PID:-}" ]] && kill "${STREAM_PID}" 2>/dev/null || true
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

# --- 1. Web session (Auth.js credentials flow) ------------------------------
CSRF_JSON="$(curl -fsS -c "${COOKIES}" "${BASE_URL}/api/auth/csrf")"
CSRF_TOKEN="$(printf '%s' "${CSRF_JSON}" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')"
[[ -n "${CSRF_TOKEN}" ]] || { echo "live-smoke: FAIL — no csrf token" >&2; exit 1; }

curl -fsS -o /dev/null -b "${COOKIES}" -c "${COOKIES}" \
  -X POST "${BASE_URL}/api/auth/callback/local" \
  --data-urlencode "csrfToken=${CSRF_TOKEN}" \
  --data-urlencode "email=${SMOKE_EMAIL}" \
  --data-urlencode "password=${SMOKE_PASSWORD}"

grep -q 'session-token' "${COOKIES}" || {
  echo "live-smoke: FAIL — sign-in as ${SMOKE_EMAIL} produced no session cookie" >&2
  exit 1
}

# --- 2. Open the SSE stream and subscribe to the target channel -------------
curl -sN -b "${COOKIES}" -H 'accept: text/event-stream' \
  --max-time 120 "${BASE_URL}/live/stream" > "${STREAM_LOG}" &
STREAM_PID=$!

CONN_ID=""
for _ in $(seq 1 40); do
  CONN_ID="$(sed -n 's/.*"connId":"\([^"]*\)".*/\1/p' "${STREAM_LOG}" | head -1)"
  [[ -n "${CONN_ID}" ]] && break
  sleep 0.25
done
[[ -n "${CONN_ID}" ]] || { echo "live-smoke: FAIL — no hello/connId on /live/stream" >&2; exit 1; }

# --- 3. Author acts through the cms container -------------------------------
# Strapi JWT is only obtainable inside the network (edge routes /api/auth to
# Next). Heredoc via `docker exec -i` (the -i is load-bearing).
TARGET_AND_RESULT="$(docker exec -i "${CMS_CONTAINER}" node --input-type=module - "${SMOKE_AUTHOR_EMAIL}" "${SMOKE_AUTHOR_PASSWORD}" << 'NODE'
const [email, password] = process.argv.slice(2);
const base = "http://127.0.0.1:1337";
const login = await fetch(`${base}/api/auth/local`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ identifier: email, password }),
});
if (!login.ok) { console.error(`login ${login.status}`); process.exit(1); }
const { jwt } = await login.json();
const list = await fetch(`${base}/api/announcements?sort=createdAt:desc&pagination[pageSize]=1&fields[0]=documentId`, {
  headers: { authorization: `Bearer ${jwt}` },
});
const target = (await list.json())?.data?.[0]?.documentId;
if (!target) { console.error("no visible announcement to comment on"); process.exit(1); }
console.log(`TARGET=${target}`);
const comment = await fetch(`${base}/api/comments`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ data: { body: `[live-smoke] ${process.pid}`, targetType: "announcement", targetDocumentId: target } }),
});
if (!comment.ok) { console.error(`comment ${comment.status}`); process.exit(1); }
const created = await comment.json();
console.log(`COMMENT_ID=${created?.data?.documentId ?? created?.data?.id ?? "?"}`);
NODE
)"
TARGET_DOC_ID="$(printf '%s\n' "${TARGET_AND_RESULT}" | sed -n 's/^TARGET=//p')"
echo "live-smoke: comment posted on announcement:${TARGET_DOC_ID}"

# Subscribe AFTER we know the target (mirrors the client: subscribe only to
# channels the pages served you). The ping for the comment above is already
# gone — post a second comment after subscribing for the real assertion.
curl -fsS -o /dev/null -b "${COOKIES}" \
  -X POST "${BASE_URL}/live/subscribe" \
  -H 'content-type: application/json' \
  --data "{\"connId\":\"${CONN_ID}\",\"add\":[\"announcement:${TARGET_DOC_ID}\"]}"

docker exec -i "${CMS_CONTAINER}" node --input-type=module - "${SMOKE_AUTHOR_EMAIL}" "${SMOKE_AUTHOR_PASSWORD}" "${TARGET_DOC_ID}" << 'NODE'
const [email, password, target] = process.argv.slice(2);
const base = "http://127.0.0.1:1337";
const { jwt } = await (await fetch(`${base}/api/auth/local`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ identifier: email, password }),
})).json();
const res = await fetch(`${base}/api/comments`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
  body: JSON.stringify({ data: { body: "[live-smoke] assert ping", targetType: "announcement", targetDocumentId: target } }),
});
if (!res.ok) { console.error(`comment ${res.status}`); process.exit(1); }
NODE

# --- 4. Assert the ping frame arrives ---------------------------------------
DEADLINE=$(( $(date +%s) + ASSERT_SECONDS ))
while (( $(date +%s) < DEADLINE )); do
  if grep -q "announcement:${TARGET_DOC_ID}" "${STREAM_LOG}"; then
    echo "live-smoke: OK — ping frame received on announcement:${TARGET_DOC_ID}"
    exit 0
  fi
  sleep 0.5
done

echo "live-smoke: FAIL — no ping within ${ASSERT_SECONDS}s. Stream so far:" >&2
tail -20 "${STREAM_LOG}" >&2 || true
echo "live-smoke: check 'docker logs ${CMS_CONTAINER} | grep live-emit' and 'docker logs infra-web-1 | grep \\[live\\]'" >&2
exit 1
