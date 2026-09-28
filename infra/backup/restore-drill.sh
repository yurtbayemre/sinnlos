#!/usr/bin/env bash
#
# restore-drill.sh — proves that the newest encrypted database backup of
# infra/backup/pg-backup.sh restores (FX36). Runs OFF-BOX, on the NAS or the
# owner's machine: the GPG private key and its passphrase never live on the
# production host, which can only encrypt.
#
# What it does:
#   1. picks the newest sinnlos-db-<YYYYmmdd-HHMMSS>[-predeploy].dump.gz.gpg
#      in the given directory (the NAS copy of offsite/sinnlos), or takes the
#      given file, and warns when it is older than MAX_AGE_HOURS (36; the
#      nightly cron may have stopped);
#   2. starts a throwaway Postgres 16 container: no network, data on a
#      tmpfs, removed with its volumes on exit (--keep leaves it running);
#   3. streams gpg --decrypt | gunzip | pg_restore into it, so no decrypted
#      byte lands on this machine's disk, and stops at the first restore
#      error;
#   4. prints the row count of every table and a summary, and fails unless
#      the users table (up_users) came back.
# With --all it also decrypts the newest uploads and .env artifacts of the
# same directory and checks them (a tar listing, a key count; nothing is
# printed or written).
#
# Needs bash, gpg, gunzip, tar and docker. Exit codes: 0 restored, 1 failed,
# 2 usage.
set -euo pipefail
umask 077

usage() {
  cat >&2 <<'USAGE'
Usage: infra/backup/restore-drill.sh [options] <artifact dir | sinnlos-db-<ts>.dump.gz.gpg>
  --key FILE              import this private key into a throwaway keyring
                          (default: your own keyring, GNUPGHOME or ~/.gnupg)
  --passphrase-file FILE  the key's passphrase, for unattended runs
                          (default: gpg asks on the terminal)
  --all                   also check the newest uploads and .env artifacts
  --image IMAGE           default postgres:16-alpine
  --name NAME             container name (default sinnlos-restore-drill-<pid>)
  --keep                  leave the container running for inspection
USAGE
  exit 2
}

IMAGE="postgres:16-alpine"
NAME="sinnlos-restore-drill-$$"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-36}"
KEY_FILE=""
PASSPHRASE_FILE=""
CHECK_ALL=0
KEEP=0
TARGET=""

while (($#)); do
  case "$1" in
    --key) KEY_FILE="${2:?--key needs a file}"; shift 2 ;;
    --passphrase-file) PASSPHRASE_FILE="${2:?--passphrase-file needs a file}"; shift 2 ;;
    --all) CHECK_ALL=1; shift ;;
    --image) IMAGE="${2:?--image needs an image}"; shift 2 ;;
    --name) NAME="${2:?--name needs a name}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h | --help) usage ;;
    -*) echo "restore-drill: unknown option $1" >&2; usage ;;
    *)
      [[ -z "$TARGET" ]] || { echo "restore-drill: give one artifact dir or file" >&2; usage; }
      TARGET="$1"; shift ;;
  esac
done
[[ -n "$TARGET" ]] || usage

say() { printf 'restore-drill: %s\n' "$*"; }
fail() { printf 'restore-drill: FAIL — %s\n' "$*" >&2; exit 1; }

# The newest artifact of one stem in a directory, by the timestamp in its
# name (nightly and -predeploy alike); empty when there is none.
newest_artifact() {  # <dir> <stem> <ext>
  local dir="$1" stem="$2" ext="$3" path name best="" best_ts="" ts re
  re="^${stem}-([0-9]{8}-[0-9]{6})(-predeploy)?\\.${ext}\\.gz\\.gpg\$"
  for path in "$dir/$stem-"*".$ext.gz.gpg"; do
    name="${path##*/}"
    [[ "$name" =~ $re ]] || continue
    ts="${BASH_REMATCH[1]}"
    if [[ -z "$best_ts" || "$ts" > "$best_ts" ]]; then best="$path"; best_ts="$ts"; fi
  done
  printf '%s' "$best"
}

if [[ -d "$TARGET" ]]; then
  DIR="$TARGET"
  DUMP="$(newest_artifact "$DIR" sinnlos-db dump)"
  [[ -n "$DUMP" ]] || fail "no sinnlos-db-<timestamp>.dump.gz.gpg in $DIR"
elif [[ -f "$TARGET" ]]; then
  DUMP="$TARGET"
  DIR="$(dirname "$TARGET")"
else
  fail "$TARGET is neither a directory nor a file"
fi
DUMP_NAME="${DUMP##*/}"
[[ "$DUMP_NAME" =~ ^sinnlos-db-([0-9]{8})-([0-9]{6})(-predeploy)?\.dump\.gz\.gpg$ ]] ||
  fail "$DUMP_NAME is not named like a pg-backup.sh database artifact"
D="${BASH_REMATCH[1]}" T="${BASH_REMATCH[2]}" KIND="nightly"
[[ -z "${BASH_REMATCH[3]}" ]] || KIND="pre-deploy"
TAKEN="${D:0:4}-${D:4:2}-${D:6:2} ${T:0:2}:${T:2:2}:${T:4:2}"
say "artifact $DUMP_NAME ($KIND, taken $TAKEN host time)"

# Age by the name (the backup host's time, read in this machine's zone:
# good to the hour, enough for a stale-cron warning).
if TAKEN_EPOCH="$(date -d "$TAKEN" +%s 2>/dev/null)"; then
  AGE_HOURS=$((($(date +%s) - TAKEN_EPOCH) / 3600))
  if ((AGE_HOURS > MAX_AGE_HOURS)); then
    say "WARNING — this backup is ${AGE_HOURS} h old (more than ${MAX_AGE_HOURS} h): check the"
    say "          nightly cron, backup.log and last-success on the host"
  fi
fi

WORK="$(mktemp -d)"
CONTAINER_STARTED=0
cleanup() {
  local rc=$?
  if ((CONTAINER_STARTED)) && ! ((KEEP && rc == 0)); then
    docker rm -f -v "$NAME" >/dev/null 2>&1 || true
  fi
  if [[ -d "$WORK/gnupg" ]]; then
    gpgconf --homedir "$WORK/gnupg" --kill gpg-agent >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# gpg: a throwaway keyring holding the supplied key, or the caller's own.
GPG=(gpg --quiet)
if [[ -n "$KEY_FILE" ]]; then
  mkdir -p "$WORK/gnupg"
  GPG+=(--homedir "$WORK/gnupg")
  "${GPG[@]}" --batch --import "$KEY_FILE" 2>/dev/null || fail "could not import the key in $KEY_FILE"
fi
if [[ -n "$PASSPHRASE_FILE" ]]; then
  GPG+=(--batch --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE")
else
  # gpg asks for the passphrase on the terminal (stdin carries the data).
  GPG_TTY="${GPG_TTY:-$(tty 2>/dev/null || true)}"
  export GPG_TTY
fi

say "starting a throwaway $IMAGE ($NAME: no network, data on tmpfs)"
# No network, so trust auth opens nothing; no password to hand around.
docker run -d --name "$NAME" --network none --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=drill -e POSTGRES_DB=drill -e POSTGRES_HOST_AUTH_METHOD=trust \
  "$IMAGE" >/dev/null || fail "could not start $IMAGE"
CONTAINER_STARTED=1
# Over TCP on the container's loopback: the image's init-time server listens
# on the socket only, so this answers once the real server is up.
ready=0
for _ in $(seq 1 90); do
  if docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U drill -d drill >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
((ready)) || fail "the throwaway Postgres did not become ready (docker logs $NAME)"

say "decrypting and restoring (pg_restore --exit-on-error)"
"${GPG[@]}" --decrypt "$DUMP" | gunzip |
  docker exec -i "$NAME" pg_restore -h 127.0.0.1 -U drill -d drill --no-owner --no-privileges --exit-on-error ||
  fail "decrypt or restore failed (wrong key or passphrase, a damaged artifact, or the restore error above)"

COUNTS="$(docker exec -i "$NAME" psql -X -q -tA -F ' ' -v ON_ERROR_STOP=1 -h 127.0.0.1 -U drill -d drill <<'SQL'
SELECT table_name,
       (xpath('/row/c/text()',
              query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name),
                           false, true, '')))[1]::text::bigint
  FROM information_schema.tables
 WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
 ORDER BY table_name;
SQL
)" || fail "could not count the restored rows"

printf '%-48s %12s\n' "table" "rows"
tables=0 rows=0 users=""
while read -r table count; do
  [[ -n "$table" ]] || continue
  printf '%-48s %12s\n' "$table" "$count"
  tables=$((tables + 1))
  rows=$((rows + count))
  [[ "$table" != "up_users" ]] || users="$count"
done <<<"$COUNTS"
[[ -n "$users" ]] || fail "the restored database has no up_users table: not a sinnlos backup?"

if ((CHECK_ALL)); then
  UPLOADS="$(newest_artifact "$DIR" sinnlos-uploads tar)"
  if [[ -n "$UPLOADS" ]]; then
    files="$("${GPG[@]}" --decrypt "$UPLOADS" | gunzip | tar -tf - | awk '!/\/$/ { n++ } END { print n + 0 }')" ||
      fail "${UPLOADS##*/} did not decrypt to a tar archive"
    say "uploads: ${UPLOADS##*/} holds ${files} file(s)"
  else
    say "uploads: no sinnlos-uploads artifact in $DIR"
  fi
  ENV_ARTIFACT="$(newest_artifact "$DIR" sinnlos-env env)"
  if [[ -n "$ENV_ARTIFACT" ]]; then
    keys="$("${GPG[@]}" --decrypt "$ENV_ARTIFACT" | gunzip | awk '/^[A-Z][A-Z0-9_]*=/ { n++ } END { print n + 0 }')" ||
      fail "${ENV_ARTIFACT##*/} did not decrypt"
    say "env: ${ENV_ARTIFACT##*/} holds ${keys} key(s) (values not shown)"
  else
    say "env: no sinnlos-env artifact in $DIR"
  fi
fi

say "OK — $DUMP_NAME restored: ${tables} tables, ${rows} rows, ${users} user(s)"
if ((KEEP)); then
  say "--keep: $NAME keeps running (no network); inspect and remove it with"
  say "  docker exec -it $NAME psql -U drill -d drill"
  say "  docker rm -f -v $NAME"
fi
