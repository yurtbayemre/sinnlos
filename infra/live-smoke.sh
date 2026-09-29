#!/usr/bin/env bash
#
# live-smoke.sh — end-to-end probe of the SSE live pipeline (issue #17/#27).
#
# The whole pipeline is fire-and-forget by design (CMS emit → web bus →
# SSE stream), so it can fail SILENTLY while every container looks healthy:
# streams open, heartbeats flow, but no ping ever arrives and the app
# quietly degrades to polling. This script is the guard against exactly
# that — run it after every deploy (deploy.sh calls it).
#
# Chain under test:
#   1. Sign in to the web app as a demo user (SMOKE_EMAIL, Auth.js
#      credentials flow) and hold an open `curl -N --compressed` on
#      /live/stream: the stream must be text/event-stream WITHOUT a
#      Content-Encoding (a compressing edge buffers the pings).
#   2. Pick the target announcement with GETs only, as a SECOND demo user
#      (SMOKE_AUTHOR_EMAIL) inside the cms container (the edge routes
#      /api/auth/* to Next, so the Strapi JWT is only obtainable
#      internally): the newest visible announcement written by SMOKE_EMAIL
#      if there is one, else the newest visible announcement.
#   3. Subscribe the stream to that announcement's channel, then post ONE
#      "[live-smoke]" comment as SMOKE_AUTHOR_EMAIL.
#   4. Assert the content ping for that channel within ASSERT_SECONDS; when
#      the announcement is SMOKE_EMAIL's own, the comment notifies
#      SMOKE_EMAIL, and the notification ping must arrive on the stream too
#      (the notification frame path).
# On exit, also after a failure: the "[live-smoke]" comments are deleted
# (through the cms, as their author), and so are the comment notifications
# this run caused (in the database: type comment, actor SMOKE_AUTHOR_EMAIL,
# created since this run started), so no deploy leaves residue behind.
#
# Before that, a datetime-contract check (docs/DEPLOYMENT.md): no column of
# the app schema may still be `timestamp without time zone`, and the cms
# boot log must report the process zone UTC.
#
# An Entra-only instance (the web runs with ENTRA_ENABLED=1 and without
# AUTH_LOCAL_ENABLED=1) has no local sign-in for the demo accounts: after the
# datetime check the script says so, skips steps 1-4 and exits 0 (check the
# live pings in a browser there).
#
# Passwords never appear on a command line (the host's process list): curl
# reads SMOKE_PASSWORD from stdin, and the cms container gets
# SMOKE_AUTHOR_PASSWORD through `docker exec -e`.
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
# Other settings: BASE_URL (the public origin), CMS_CONTAINER, WEB_CONTAINER,
# DB_CONTAINER (infra-{cms,web,db}-1), DB_SCHEMA (public), ASSERT_SECONDS (5).
#
# Notes:
#   - Watch the Strapi login rate limit (10 fails/60s per IP) when
#     iterating on this script.
#   - Without a visible announcement the script fails loudly (seeded prod
#     has some).
#
set -euo pipefail

BASE_URL="${BASE_URL:-https://sinnlos.yurtbay.dev}"
BASE_URL="${BASE_URL%/}"
CMS_CONTAINER="${CMS_CONTAINER:-infra-cms-1}"
WEB_CONTAINER="${WEB_CONTAINER:-infra-web-1}"
DB_CONTAINER="${DB_CONTAINER:-infra-db-1}"
DB_SCHEMA="${DB_SCHEMA:-public}"
ASSERT_SECONDS="${ASSERT_SECONDS:-5}"
PASSWORDS_FILE="${PASSWORDS_FILE:-/home/bigemo/.sinnlos-env-backup/demo-account-passwords.txt}"

SMOKE_EMAIL="${SMOKE_EMAIL:-casey.jones@sinnlos.local}"
SMOKE_AUTHOR_EMAIL="${SMOKE_AUTHOR_EMAIL:-sam.chen@sinnlos.local}"

fail() {
  echo "live-smoke: FAIL — $*" >&2
  exit 1
}

# psql in the db container; extra arguments go to psql (after -X -q -tA).
db_psql() {
  # $POSTGRES_USER / $POSTGRES_DB expand in the db container's sh.
  # shellcheck disable=SC2016
  docker exec -i "${DB_CONTAINER}" sh -c 'psql -X -q -tA -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"' psql "$@"
}

# --- 0. Datetime contract -----------------------------------------------------
# The cms guard converts every naive timestamp column at boot and refuses to
# start while one remains; this catches a guard that stopped working and a
# cms container that is not in UTC.
NAIVE_COLUMNS="$(db_psql <<SQL
SELECT coalesce(string_agg(table_name || '.' || column_name, ', ' ORDER BY table_name, column_name), '')
  FROM information_schema.columns
 WHERE table_schema = '${DB_SCHEMA}' AND data_type = 'timestamp without time zone';
SQL
)" || fail "could not query ${DB_CONTAINER} for naive timestamp columns"
if [[ -n "${NAIVE_COLUMNS}" ]]; then
  fail "timestamp without time zone columns remain (datetime contract): ${NAIVE_COLUMNS}"
fi
CMS_ZONE_LINE="$(docker logs "${CMS_CONTAINER}" 2>&1 | grep -F '[datetime] process time zone' | tail -n 1 || true)"
if [[ "${CMS_ZONE_LINE}" != *"process time zone UTC,"* && "${CMS_ZONE_LINE}" != *"process time zone Etc/UTC,"* ]]; then
  fail "the cms does not report the process zone UTC: ${CMS_ZONE_LINE:-no [datetime] boot line in docker logs ${CMS_CONTAINER}}"
fi
echo "live-smoke: datetime contract OK (${CMS_ZONE_LINE##*\[datetime\] })"

# --- Entra-only instance: no local sign-in for the demo accounts ------------
# The web offers local sign-in unless ENTRA_ENABLED is exactly 1 and
# AUTH_LOCAL_ENABLED is not 1 (apps/web/src/lib/auth-config.ts); the cms
# follows the same switches. Only these two variables leave the pipe.
# When the web container cannot be inspected, the sign-in below says why.
WEB_SWITCHES="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${WEB_CONTAINER}" 2>/dev/null |
  grep -E '^(ENTRA_ENABLED|AUTH_LOCAL_ENABLED)=' || true)"
if grep -qx 'ENTRA_ENABLED=1' <<<"${WEB_SWITCHES}" && ! grep -qx 'AUTH_LOCAL_ENABLED=1' <<<"${WEB_SWITCHES}"; then
  echo "live-smoke: SKIPPED the sign-in steps: Entra-only instance (${WEB_CONTAINER} runs with ENTRA_ENABLED=1"
  echo "live-smoke: and without AUTH_LOCAL_ENABLED=1), so the demo accounts cannot sign in. Check the live pings"
  echo "live-smoke: in a browser: a comment from a second session refreshes the card in the first."
  exit 0
fi

lookup_password() {
  local email="$1"
  # File is TAB-separated; [[:space:]] matches both. `|| true` keeps a
  # missing entry from silently killing the whole script via pipefail —
  # the explicit -z check below reports it loudly instead.
  { grep "^${email}[[:space:]]" "${PASSWORDS_FILE}" 2>/dev/null | awk '{print $2}' | head -1; } || true
}

if [[ -z "${SMOKE_PASSWORD:-}" ]]; then
  SMOKE_PASSWORD="$(lookup_password "${SMOKE_EMAIL}")"
fi
if [[ -z "${SMOKE_AUTHOR_PASSWORD:-}" ]]; then
  SMOKE_AUTHOR_PASSWORD="$(lookup_password "${SMOKE_AUTHOR_EMAIL}")"
fi
if [[ -z "${SMOKE_PASSWORD}" || -z "${SMOKE_AUTHOR_PASSWORD}" ]]; then
  fail "missing passwords (set SMOKE_PASSWORD/SMOKE_AUTHOR_PASSWORD or provide ${PASSWORDS_FILE})"
fi

# The author's side, inside the cms container: sign in as SMOKE_AUTHOR_EMAIL
# (password from the environment), then MODE discover (GETs only: prints
# TARGET=<documentId> and KIND=own|newest), comment (one "[live-smoke]"
# comment on TARGET) or cleanup (deletes every "[live-smoke]" comment).
CMS_PROBE="$(cat <<'NODE'
const { MODE, SMOKE_AUTHOR_EMAIL: identifier, SMOKE_AUTHOR_PASSWORD: password, STREAM_USER_ID, TARGET } = process.env;
const base = "http://127.0.0.1:1337";
const login = await fetch(`${base}/api/auth/local`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ identifier, password }),
});
if (!login.ok) {
  console.error(`sign-in as ${identifier} inside the cms failed: HTTP ${login.status}`);
  process.exit(1);
}
const { jwt } = await login.json();
const auth = { authorization: `Bearer ${jwt}` };
if (MODE === "discover") {
  const newest = async (filter) => {
    const res = await fetch(`${base}/api/announcements?${filter}sort=createdAt:desc&pagination[pageSize]=1&fields[0]=documentId`, { headers: auth });
    if (!res.ok) {
      console.error(`GET /api/announcements answered HTTP ${res.status}`);
      process.exit(1);
    }
    return (await res.json())?.data?.[0]?.documentId;
  };
  const own = /^[0-9]+$/.test(STREAM_USER_ID ?? "") ? await newest(`filters[author][id][$eq]=${STREAM_USER_ID}&`) : undefined;
  const target = own ?? (await newest(""));
  if (!target) {
    console.error("no visible announcement to comment on");
    process.exit(1);
  }
  console.log(`TARGET=${target}`);
  console.log(`KIND=${own ? "own" : "newest"}`);
} else if (MODE === "comment") {
  const res = await fetch(`${base}/api/comments`, {
    method: "POST",
    headers: { "content-type": "application/json", ...auth },
    body: JSON.stringify({ data: { body: `[live-smoke] ${process.pid}`, targetType: "announcement", targetDocumentId: TARGET } }),
  });
  if (!res.ok) {
    console.error(`POST /api/comments answered HTTP ${res.status}`);
    process.exit(1);
  }
} else if (MODE === "cleanup") {
  const res = await fetch(`${base}/api/comments?filters[body][$startsWith]=${encodeURIComponent("[live-smoke]")}&pagination[pageSize]=50`, { headers: auth });
  let removed = 0;
  for (const row of (await res.json())?.data ?? []) {
    const del = await fetch(`${base}/api/comments/${row.documentId}`, { method: "DELETE", headers: auth });
    if (del.ok) removed += 1;
  }
  console.log(`${removed}`);
} else {
  console.error(`unknown MODE ${MODE}`);
  process.exit(2);
}
NODE
)"

# Runs CMS_PROBE in the cms container. $1 = MODE; TARGET and STREAM_USER_ID
# come from this script's variables. The password travels in the
# environment of `docker exec`, never on its command line.
cms_probe() {
  printf '%s\n' "${CMS_PROBE}" |
    MODE="$1" TARGET="${TARGET_DOC_ID:-}" STREAM_USER_ID="${STREAM_USER_ID:-}" \
      SMOKE_AUTHOR_EMAIL="${SMOKE_AUTHOR_EMAIL}" SMOKE_AUTHOR_PASSWORD="${SMOKE_AUTHOR_PASSWORD}" \
      docker exec -i -e MODE -e TARGET -e STREAM_USER_ID -e SMOKE_AUTHOR_EMAIL -e SMOKE_AUTHOR_PASSWORD \
      "${CMS_CONTAINER}" node --input-type=module -
}

WORKDIR="$(mktemp -d)"
STREAM_LOG="${WORKDIR}/stream.log"
STREAM_HEADERS="${WORKDIR}/stream.headers"
COOKIES="${WORKDIR}/cookies.txt"
RUN_STARTED=""
# shellcheck disable=SC2329 # runs from the EXIT trap below
cleanup() {
  if [[ -n "${STREAM_PID:-}" ]]; then kill "${STREAM_PID}" 2>/dev/null || true; fi
  # Best-effort, also on the failure paths: remove the probe comments this
  # (and any earlier crashed) run left behind, then the comment
  # notifications this run caused. Every deploy runs this script.
  local comments notifications
  comments="$(cms_probe cleanup 2>/dev/null)" || comments="?"
  if [[ -n "${RUN_STARTED}" ]]; then
    notifications="$(SMOKE_AUTHOR_EMAIL="${SMOKE_AUTHOR_EMAIL}" RUN_STARTED="${RUN_STARTED}" \
      docker exec -i -e SMOKE_AUTHOR_EMAIL -e RUN_STARTED "${DB_CONTAINER}" \
      sh -c 'psql -X -q -tA -v ON_ERROR_STOP=1 -v author="$SMOKE_AUTHOR_EMAIL" -v since="$RUN_STARTED" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
      2>/dev/null <<'SQL'
WITH doomed AS (
  SELECT n.id FROM notifications n
    JOIN notifications_actor_lnk a ON a.notification_id = n.id
    JOIN up_users u ON u.id = a.user_id
   WHERE lower(u.email) = lower(:'author') AND n.type = 'comment'
     AND n.link = '/announcements' AND n.created_at >= :'since'::timestamptz
), actor_links AS (
  DELETE FROM notifications_actor_lnk l USING doomed d WHERE l.notification_id = d.id RETURNING l.id
), recipient_links AS (
  DELETE FROM notifications_recipient_lnk l USING doomed d WHERE l.notification_id = d.id RETURNING l.id
), removed AS (
  DELETE FROM notifications n USING doomed d WHERE n.id = d.id RETURNING n.id
)
SELECT count(*) FROM removed;
SQL
    )" || notifications="?"
  else
    notifications="0"
  fi
  echo "live-smoke: cleanup removed ${comments} probe comment(s) and ${notifications} probe notification(s)"
  rm -rf "${WORKDIR}"
}
trap cleanup EXIT

# --- 1. Web session (Auth.js credentials flow) ------------------------------
CSRF_STATUS="$(curl -sS -o "${WORKDIR}/csrf.json" -w '%{http_code}' --max-time 15 -c "${COOKIES}" \
  "${BASE_URL}/api/auth/csrf")" || fail "sign-in: GET ${BASE_URL}/api/auth/csrf did not answer"
[[ "${CSRF_STATUS}" == "200" ]] || fail "sign-in: GET ${BASE_URL}/api/auth/csrf answered HTTP ${CSRF_STATUS}"
CSRF_TOKEN="$(sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p' "${WORKDIR}/csrf.json")"
[[ -n "${CSRF_TOKEN}" ]] || fail "sign-in: no csrfToken in the answer of ${BASE_URL}/api/auth/csrf"

# The password goes to curl on stdin (`password@-`), not on its command line.
SIGNIN_RESULT="$(printf '%s' "${SMOKE_PASSWORD}" |
  curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 20 -b "${COOKIES}" -c "${COOKIES}" \
    -X POST "${BASE_URL}/api/auth/callback/local" \
    --data-urlencode "csrfToken=${CSRF_TOKEN}" \
    --data-urlencode "identifier=${SMOKE_EMAIL}" \
    --data-urlencode "password@-")" || fail "sign-in: POST ${BASE_URL}/api/auth/callback/local did not answer"
grep -q 'session-token' "${COOKIES}" ||
  fail "sign-in as ${SMOKE_EMAIL} produced no session cookie (HTTP ${SIGNIN_RESULT%% *}, redirect ${SIGNIN_RESULT#* }): wrong password in ${PASSWORDS_FILE}, a locked or blocked account, or local sign-in switched off"

SESSION_JSON="$(curl -sS --max-time 15 -b "${COOKIES}" "${BASE_URL}/api/auth/session")" ||
  fail "sign-in: GET ${BASE_URL}/api/auth/session did not answer"
STREAM_USER_ID="$(printf '%s' "${SESSION_JSON}" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')"
[[ -n "${STREAM_USER_ID}" ]] || fail "sign-in as ${SMOKE_EMAIL}: the session names no user id"

# --- 2. Open the SSE stream --------------------------------------------------
# --compressed offers gzip/br/zstd like a browser does: a stream that comes
# back with a Content-Encoding is buffered by the encoder at the edge.
curl -sS -N --compressed -D "${STREAM_HEADERS}" -b "${COOKIES}" -H 'accept: text/event-stream' \
  --max-time 120 "${BASE_URL}/live/stream" > "${STREAM_LOG}" 2> "${WORKDIR}/stream.err" &
STREAM_PID=$!

HEADERS_DONE=0
for _ in $(seq 1 60); do
  if [[ -s "${STREAM_HEADERS}" ]] && tr -d '\r' < "${STREAM_HEADERS}" | grep -qx ''; then
    HEADERS_DONE=1
    break
  fi
  sleep 0.25
done
((HEADERS_DONE)) || fail "subscribe: no response headers from ${BASE_URL}/live/stream within 15 s ($(tr -d '\r' < "${WORKDIR}/stream.err" | tail -n 1))"
HEADERS="${WORKDIR}/stream.headers.lf"
tr -d '\r' < "${STREAM_HEADERS}" > "${HEADERS}"
STREAM_STATUS="$(sed -n '1s/^HTTP\/[0-9.]* \([0-9][0-9][0-9]\).*/\1/p' "${HEADERS}")"
[[ "${STREAM_STATUS}" == "200" ]] ||
  fail "subscribe: GET ${BASE_URL}/live/stream answered HTTP ${STREAM_STATUS:-?} (404: LIVE_EVENTS_DISABLED=1 on the web; 401 or a redirect: the session was not accepted)"
grep -qi '^content-type: *text/event-stream' "${HEADERS}" ||
  fail "subscribe: ${BASE_URL}/live/stream is not text/event-stream ($(grep -i '^content-type:' "${HEADERS}" || echo 'no Content-Type'))"
if grep -qi '^content-encoding:' "${HEADERS}"; then
  fail "subscribe: ${BASE_URL}/live/stream came back compressed ($(grep -i '^content-encoding:' "${HEADERS}")): the edge must not compress text/event-stream, or pings wait in the encoder's buffer"
fi

CONN_ID=""
for _ in $(seq 1 40); do
  CONN_ID="$(sed -n 's/.*"connId":"\([^"]*\)".*/\1/p' "${STREAM_LOG}" | head -1)"
  [[ -n "${CONN_ID}" ]] && break
  sleep 0.25
done
[[ -n "${CONN_ID}" ]] || fail "subscribe: no hello/connId on /live/stream within 10 s"
echo "live-smoke: stream open (text/event-stream, uncompressed)"

# --- 3. Target (GETs only), subscription, one comment -----------------------
DISCOVERED="$(cms_probe discover)" || fail "could not pick an announcement (see the line above)"
TARGET_DOC_ID="$(printf '%s\n' "${DISCOVERED}" | sed -n 's/^TARGET=//p')"
TARGET_KIND="$(printf '%s\n' "${DISCOVERED}" | sed -n 's/^KIND=//p')"
[[ -n "${TARGET_DOC_ID}" ]] || fail "could not pick an announcement: ${DISCOVERED}"

SUBSCRIBE_STATUS="$(curl -sS -o "${WORKDIR}/subscribe.json" -w '%{http_code}' --max-time 15 -b "${COOKIES}" \
  -X POST "${BASE_URL}/live/subscribe" \
  -H 'content-type: application/json' \
  --data "{\"connId\":\"${CONN_ID}\",\"add\":[\"announcement:${TARGET_DOC_ID}\"]}")" ||
  fail "subscribe: POST ${BASE_URL}/live/subscribe did not answer"
[[ "${SUBSCRIBE_STATUS}" == "200" ]] ||
  fail "subscribe: POST ${BASE_URL}/live/subscribe answered HTTP ${SUBSCRIBE_STATUS}: $(head -c 200 "${WORKDIR}/subscribe.json")"

# From here on the cleanup removes the comment notifications of this run.
RUN_STARTED="$(db_psql -c 'SELECT clock_timestamp()' < /dev/null)" ||
  fail "could not read the database clock (${DB_CONTAINER})"
STREAM_OFFSET="$(wc -c < "${STREAM_LOG}")"
cms_probe comment || fail "could not post the probe comment (see the line above)"
echo "live-smoke: comment posted on announcement:${TARGET_DOC_ID}"

# --- 4. Assert the frames ------------------------------------------------------
# Content ping for the subscribed channel; with SMOKE_EMAIL's own
# announcement also the notification ping (the comment notifies its author).
CONTENT_FRAME="\"channel\":\"announcement:${TARGET_DOC_ID}\""
NOTIFICATION_FRAME='{"type":"notification"}'
DEADLINE=$(($(date +%s) + ASSERT_SECONDS))
content=0 notification=0
while (($(date +%s) < DEADLINE)); do
  FRAMES="$(tail -c "+$((STREAM_OFFSET + 1))" "${STREAM_LOG}")"
  [[ "${FRAMES}" != *"${CONTENT_FRAME}"* ]] || content=1
  [[ "${FRAMES}" != *"${NOTIFICATION_FRAME}"* ]] || notification=1
  if ((content)) && { [[ "${TARGET_KIND}" != "own" ]] || ((notification)); }; then
    break
  fi
  sleep 0.5
done

if ! ((content)); then
  echo "live-smoke: FAIL — no ping within ${ASSERT_SECONDS}s. Stream so far:" >&2
  tail -20 "${STREAM_LOG}" >&2 || true
  echo "live-smoke: check 'docker logs ${CMS_CONTAINER} | grep live-emit' and 'docker logs ${WEB_CONTAINER} | grep \\[live\\]'" >&2
  exit 1
fi
echo "live-smoke: OK — ping frame received on announcement:${TARGET_DOC_ID}"
if [[ "${TARGET_KIND}" == "own" ]]; then
  if ! ((notification)); then
    echo "live-smoke: FAIL — the comment on ${SMOKE_EMAIL}'s own announcement sent no notification ping within ${ASSERT_SECONDS}s" >&2
    echo "live-smoke: check 'docker logs ${CMS_CONTAINER} | grep -E \"live-emit|notifications\"'" >&2
    exit 1
  fi
  echo "live-smoke: OK — notification frame received (the comment notified ${SMOKE_EMAIL}, the announcement's author)"
else
  echo "live-smoke: notification frame path not checked: ${SMOKE_EMAIL} has no visible announcement of their own"
fi
exit 0
