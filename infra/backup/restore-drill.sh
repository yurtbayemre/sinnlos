#!/usr/bin/env bash
#
# restore-drill.sh — proves that a database backup restores (FX36). Runs
# OFF-BOX, on the NAS or the owner's machine: the private keys (GPG, age)
# never live on the production host, which can only encrypt.
#
# Two kinds of backup:
#
# A. infra/backup/pg-backup.sh artifacts (GPG; hosts without backup-run):
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
#   With --all it also decrypts the uploads and .env artifacts of the same
#   backup run (pg-backup.sh names all three with one timestamp and kind) and
#   checks them (a tar listing, a key count; nothing is printed or written);
#   either one missing fails the drill (a partial run).
#
# B. --generation <dir> --identity <age key file>: a backup-run generation of
#   production (srv-prod-01-ops; <YYYYMMDD>T<HHMMSS>Z-<daily|predeploy>/ of
#   the NAS copy of /srv/backup/outbox/sinnlos):
#   1. checks it as backup-verify does: COMPLETE exists and names the
#      directory, and MANIFEST lists every other file with its sha256, and no
#      file is missing or extra; warns when it is older than MAX_AGE_HOURS;
#   2. decrypts every component (age -d -i <identity> | zstd -d) into a
#      private temporary directory (mode 700, removed on exit) and compares
#      each plaintext with plain.<component>.sha256 of MANIFEST; db.dump,
#      db-globals.sql, uploads.tar and config.tar must all be there;
#   3. restores db.dump into a throwaway Postgres 16 container as in A
#      (a clean database, pg_restore --exit-on-error --single-transaction),
#      prints the row count of every table and fails unless up_users came
#      back;
#   4. lists uploads.tar (a file count and the first names) and config.tar
#      (its names, and for each .env the number of keys; no value is shown).
#
# Needs bash, docker and coreutils; A also gpg, gunzip and tar; B also age,
# zstd and tar. Exit codes: 0 restored, 1 failed, 2 usage.
set -euo pipefail
umask 077

usage() {
  cat >&2 <<'USAGE'
Usage: infra/backup/restore-drill.sh [options] <artifact dir | sinnlos-db-<ts>.dump.gz.gpg>
       infra/backup/restore-drill.sh [options] --generation <dir> --identity <age key file>
  --key FILE              GPG: import this private key into a throwaway keyring
                          (default: your own keyring, GNUPGHOME or ~/.gnupg)
  --passphrase-file FILE  GPG: the key's passphrase, for unattended runs
                          (default: gpg asks on the terminal)
  --all                   GPG: also check the uploads and .env artifacts of the same run
  --generation DIR        a backup-run generation (age), e.g. <copy of outbox>/sinnlos/20261012T180345Z-predeploy
  --identity FILE         its age identity (private key) file
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
GENERATION=""
IDENTITY=""

while (($#)); do
  case "$1" in
    --key) KEY_FILE="${2:?--key needs a file}"; shift 2 ;;
    --passphrase-file) PASSPHRASE_FILE="${2:?--passphrase-file needs a file}"; shift 2 ;;
    --all) CHECK_ALL=1; shift ;;
    --generation) GENERATION="${2:?--generation needs a directory}"; shift 2 ;;
    --identity) IDENTITY="${2:?--identity needs a file}"; shift 2 ;;
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
if [[ -n "$GENERATION" || -n "$IDENTITY" ]]; then
  [[ -n "$GENERATION" && -n "$IDENTITY" ]] || { echo "restore-drill: --generation and --identity go together" >&2; usage; }
  if [[ -n "$TARGET" || -n "$KEY_FILE" || -n "$PASSPHRASE_FILE" ]] || ((CHECK_ALL)); then
    echo "restore-drill: --generation takes no artifact, --key, --passphrase-file or --all" >&2
    usage
  fi
else
  [[ -n "$TARGET" ]] || usage
fi

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

# Warns when a backup taken at "<date> <time>" (in the zone date -d reads it
# in) is older than MAX_AGE_HOURS: good to the hour, enough for a stale-cron
# warning.
warn_age() {  # <taken> <what to check>
  local taken_epoch age_hours
  if taken_epoch="$(date -d "$1" +%s 2>/dev/null)"; then
    age_hours=$((($(date +%s) - taken_epoch) / 3600))
    if ((age_hours > MAX_AGE_HOURS)); then
      say "WARNING — this backup is ${age_hours} h old (more than ${MAX_AGE_HOURS} h): check $2"
    fi
  fi
}

WORK="$(mktemp -d)"
chmod 700 "$WORK"
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

start_postgres() {
  say "starting a throwaway $IMAGE ($NAME: no network, data on tmpfs)"
  # No network, so trust auth opens nothing; no password to hand around.
  docker run -d --name "$NAME" --network none --tmpfs /var/lib/postgresql/data \
    -e POSTGRES_USER=drill -e POSTGRES_DB=drill -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$IMAGE" >/dev/null || fail "could not start $IMAGE"
  CONTAINER_STARTED=1
  # Over TCP on the container's loopback: the image's init-time server listens
  # on the socket only, so this answers once the real server is up.
  local ready=0
  for _ in $(seq 1 90); do
    if docker exec "$NAME" pg_isready -q -h 127.0.0.1 -U drill -d drill >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  ((ready)) || fail "the throwaway Postgres did not become ready (docker logs $NAME)"
}

# Prints the row count of every restored table; sets TABLES, ROWS and USERS
# and fails unless up_users came back.
report_tables() {
  local counts table count
  counts="$(docker exec -i "$NAME" psql -X -q -tA -F ' ' -v ON_ERROR_STOP=1 -h 127.0.0.1 -U drill -d drill <<'SQL'
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
  TABLES=0 ROWS=0 USERS=""
  while read -r table count; do
    [[ -n "$table" ]] || continue
    printf '%-48s %12s\n' "$table" "$count"
    TABLES=$((TABLES + 1))
    ROWS=$((ROWS + count))
    [[ "$table" != "up_users" ]] || USERS="$count"
  done <<<"$counts"
  [[ -n "$USERS" ]] || fail "the restored database has no up_users table: not a sinnlos backup?"
}

finish() {  # <what was restored>
  say "OK — $1 restored: ${TABLES} tables, ${ROWS} rows, ${USERS} user(s)"
  if ((KEEP)); then
    say "--keep: $NAME keeps running (no network); inspect and remove it with"
    say "  docker exec -it $NAME psql -U drill -d drill"
    say "  docker rm -f -v $NAME"
  fi
}

# --- B. a backup-run generation (age) ----------------------------------------

# The sha256 MANIFEST names for a plaintext component (plain.<name>.sha256=).
manifest_plain_sha() {  # <manifest> <component>
  awk -v key="plain.$2.sha256" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' "$1"
}

# backup-verify's check: COMPLETE names the directory; MANIFEST lists every
# other file of the generation with a matching sha256, and nothing else.
verify_generation() {  # <dir>
  local dir="$1" gen="${1##*/}" complete_gen line sum file listed=() name
  [[ -f "$dir/COMPLETE" ]] ||
    fail "$gen has no COMPLETE: the backup run did not finish this generation; do not use it"
  read -r complete_gen _ <"$dir/COMPLETE" || true
  [[ "$complete_gen" == "$gen" ]] ||
    fail "COMPLETE of $gen names '${complete_gen}', not this directory: a copied or mixed-up generation"
  [[ -f "$dir/MANIFEST" ]] || fail "$gen has no MANIFEST"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^([0-9a-f]{64})\ [\ *](.+)$ ]] || continue
    sum="${BASH_REMATCH[1]}" file="${BASH_REMATCH[2]}"
    [[ "$file" != */* && "$file" != .* && "$file" != MANIFEST && "$file" != COMPLETE ]] ||
      fail "MANIFEST of $gen lists '$file', which is no file of a generation"
    [[ -f "$dir/$file" ]] || fail "$file is in MANIFEST but missing from $gen"
    [[ "$(sha256sum <"$dir/$file" | cut -d' ' -f1)" == "$sum" ]] ||
      fail "$file does not match its sha256 in MANIFEST: changed or damaged since the backup"
    listed+=("$file")
  done <"$dir/MANIFEST"
  ((${#listed[@]})) || fail "MANIFEST of $gen lists no file"
  for file in "$dir"/* "$dir"/.[!.]*; do
    [[ -e "$file" ]] || continue
    name="${file##*/}"
    [[ "$name" != MANIFEST && "$name" != COMPLETE ]] || continue
    [[ " ${listed[*]} " == *" $name "* ]] || fail "$name is in $gen but not in its MANIFEST"
  done
  say "generation $gen: COMPLETE, and ${#listed[@]} file(s) match MANIFEST"
}

drill_generation() {
  local dir="${GENERATION%/}" gen file comp want got components=() names entry keys files=0
  local day tod taken
  [[ -d "$dir" ]] || fail "$GENERATION is not a directory"
  [[ -f "$IDENTITY" && -r "$IDENTITY" ]] || fail "the identity file $IDENTITY is missing or not readable"
  gen="${dir##*/}"
  if [[ "$gen" =~ ^([0-9]{8})T([0-9]{6})Z-(daily|predeploy)$ ]]; then
    day="${BASH_REMATCH[1]}" tod="${BASH_REMATCH[2]}"
    taken="${day:0:4}-${day:4:2}-${day:6:2} ${tod:0:2}:${tod:2:2}:${tod:4:2} UTC"
    say "generation $gen (${BASH_REMATCH[3]}, taken $taken)"
    warn_age "$taken" "the backup-run timer and backup-status on the host"
  else
    say "generation $gen (not named <YYYYMMDD>T<HHMMSS>Z-<daily|predeploy>)"
  fi
  verify_generation "$dir"
  say "manifest: $(grep -E '^(service|kind|created_at|db_image|db_pg_dump_version)=' "$dir/MANIFEST" | tr '\n' ' ')"

  for file in "$dir"/*.zst.age; do
    [[ -e "$file" ]] || continue
    comp="${file##*/}"
    comp="${comp%.zst.age}"
    want="$(manifest_plain_sha "$dir/MANIFEST" "$comp")"
    [[ "$want" =~ ^[0-9a-f]{64}$ ]] || fail "MANIFEST has no plain.$comp.sha256 for ${file##*/}"
    age -d -i "$IDENTITY" "$file" | zstd -d -q -c >"$WORK/$comp" ||
      fail "could not decrypt ${file##*/} with $IDENTITY (not an identity of its recipients, or a damaged file)"
    got="$(sha256sum <"$WORK/$comp" | cut -d' ' -f1)"
    [[ "$got" == "$want" ]] ||
      fail "the plaintext of ${file##*/} does not match plain.$comp.sha256 of MANIFEST: not what was backed up"
    say "$comp: decrypted, $(wc -c <"$WORK/$comp") bytes, matches MANIFEST"
    components+=("$comp")
  done
  for comp in db.dump db-globals.sql uploads.tar config.tar; do
    [[ " ${components[*]} " == *" $comp "* ]] || fail "$gen has no $comp.zst.age: an incomplete sinnlos generation"
  done

  start_postgres
  say "restoring db.dump (pg_restore --exit-on-error --single-transaction into a clean database)"
  docker exec -i "$NAME" pg_restore -h 127.0.0.1 -U drill -d drill --no-owner --no-privileges \
    --exit-on-error --single-transaction <"$WORK/db.dump" ||
    fail "db.dump did not restore (the error above)"
  report_tables

  say "db-globals.sql: $(grep -c '^CREATE ROLE' "$WORK/db-globals.sql" || true) role(s) (not applied: only a new Postgres container needs them)"
  # Names only (awk reads the whole listing: no early pipe close under pipefail).
  names="$(tar -tf "$WORK/uploads.tar" | awk '!/\/$/')" || fail "uploads.tar is no tar archive"
  files="$(awk 'END { print NR }' <<<"$names")"
  [[ -n "$names" ]] || files=0
  if ((files > 20)); then
    say "uploads.tar: ${files} file(s), the first 20:"
  else
    say "uploads.tar: ${files} file(s)"
  fi
  awk 'NR <= 20 && $0 != "" { print "  " $0 }' <<<"$names"
  names="$(tar -tf "$WORK/config.tar")" || fail "config.tar is no tar archive"
  say "config.tar:"
  keys=""
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    if [[ "$entry" == *.env || "$entry" == .env ]]; then
      keys="$(tar -xOf "$WORK/config.tar" "$entry" | awk '/^[A-Z][A-Z0-9_]*=/ { n++ } END { print n + 0 }')"
      say "  $entry (${keys} key(s), values not shown)"
    else
      say "  $entry"
    fi
  done <<<"$names"
  [[ -n "$keys" ]] || fail "config.tar holds no .env"
  finish "generation $gen"
}

if [[ -n "$GENERATION" ]]; then
  drill_generation
  exit 0
fi

# --- A. pg-backup.sh artifacts (GPG) -----------------------------------------

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
# <ts><tag> of the run that wrote this dump, for --all.
RUN_ID="${D}-${T}${BASH_REMATCH[3]}"
[[ -z "${BASH_REMATCH[3]}" ]] || KIND="pre-deploy"
TAKEN="${D:0:4}-${D:4:2}-${D:6:2} ${T:0:2}:${T:2:2}:${T:4:2}"
say "artifact $DUMP_NAME ($KIND, taken $TAKEN host time)"
# By the name: the backup host's time, read in this machine's zone.
warn_age "$TAKEN" "the nightly cron, backup.log and last-success on the host"

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

start_postgres

say "decrypting and restoring (pg_restore --exit-on-error)"
"${GPG[@]}" --decrypt "$DUMP" | gunzip |
  docker exec -i "$NAME" pg_restore -h 127.0.0.1 -U drill -d drill --no-owner --no-privileges --exit-on-error ||
  fail "decrypt or restore failed (wrong key or passphrase, a damaged artifact, or the restore error above)"

report_tables

if ((CHECK_ALL)); then
  # The artifacts of the dump's own run, never the newest of each series:
  # retention keeps a series' newest 7 however old, so a series that stopped
  # weeks ago would pass.
  missing=()
  UPLOADS="$DIR/sinnlos-uploads-$RUN_ID.tar.gz.gpg"
  if [[ -f "$UPLOADS" ]]; then
    files="$("${GPG[@]}" --decrypt "$UPLOADS" | gunzip | tar -tf - | awk '!/\/$/ { n++ } END { print n + 0 }')" ||
      fail "${UPLOADS##*/} did not decrypt to a tar archive"
    say "uploads: ${UPLOADS##*/} holds ${files} file(s)"
  else
    missing+=("${UPLOADS##*/}")
  fi
  ENV_ARTIFACT="$DIR/sinnlos-env-$RUN_ID.env.gz.gpg"
  if [[ -f "$ENV_ARTIFACT" ]]; then
    keys="$("${GPG[@]}" --decrypt "$ENV_ARTIFACT" | gunzip | awk '/^[A-Z][A-Z0-9_]*=/ { n++ } END { print n + 0 }')" ||
      fail "${ENV_ARTIFACT##*/} did not decrypt"
    say "env: ${ENV_ARTIFACT##*/} holds ${keys} key(s) (values not shown)"
  else
    missing+=("${ENV_ARTIFACT##*/}")
  fi
  if ((${#missing[@]})); then
    fail "--all: the run of $DUMP_NAME has no ${missing[*]} in $DIR (a partial backup run: its backup.log names the skipped series; or the copy is incomplete)"
  fi
fi

finish "$DUMP_NAME"
