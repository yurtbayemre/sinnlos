#!/usr/bin/env bash
# Nightly backup of the sinnlos intranet (GPG-encrypted at rest):
#   - Postgres (infra-db-1):        pg_dump -Fc, integrity-checked via pg_restore --list
#   - Strapi uploads (infra_cms_uploads volume): tar of the media dir
#   - infra/.env (every secret; the dumps do not cover it)
# Each artifact is gzipped, then ASYMMETRICALLY encrypted to the VPS backup GPG
# public key — a VPS/NAS compromise cannot decrypt (private key + passphrase are
# off-box; infra/backup/restore-drill.sh decrypts and restores off-box). Artifacts
# land in the box's single NAS-pulled offsite dir, under a sinnlos/ namespace, so
# the existing rrsync pull replicates them automatically (see
# /home/bigemo/backups/momsbest/backup for the keyring + NAS mechanics).
#
# Plaintext never outlives the run: umask 077 for everything the run creates,
# and an EXIT trap (errors, INT/TERM/HUP included; SIGKILL cannot be trapped)
# removes this run's plaintext dump/tar/.env copies, their .gz and a partial
# .gpg. What a killed run (SIGKILL) left in the backup root is reported by
# every later run ("WARN stale plaintext" in backup.log and on stderr).
# The encrypted artifacts are 0600 and, when root runs this (deploy.sh),
# owned like the offsite dir, so the owner's cron and the NAS pull keep
# reading them; an offsite dir that a root run creates is owned like the
# backup root (which must exist, with the keyring).
#
# Retention, per series (db / uploads / env, each once for the nightly and
# once for the pre-deploy artifacts): an artifact goes only when it is older
# than RETENTION_DAYS (7, by the timestamp in its name) AND not among the
# newest RETENTION_KEEP (7) of its series. Pruning runs only after the new
# artifact of that stem is encrypted. deploy.sh runs this with
# SINNLOS_BACKUP_KIND=predeploy: those artifacts are named
# <stem>-<ts>-predeploy.<ext>.gz.gpg and retained separately, so a day of
# deploys never pushes a nightly backup out. Files of any other name in the
# offsite dir are never pruned.
#
# backup.log (in the offsite dir): one "ok" line per artifact, "skip" and
# "FAIL" lines, and "done" at the end. last-success (same dir) holds the time
# of the last complete NIGHTLY run, for an external freshness monitor (older
# than 26 h = the cron stopped); a pre-deploy run writes
# last-success-predeploy instead, so a deploy never hides a dead cron.
set -Eeuo pipefail
umask 077

DB_C="${SINNLOS_DB_CONTAINER:-infra-db-1}"
UPLOADS_VOL="${SINNLOS_UPLOADS_VOLUME:-infra_cms_uploads}"

# Keyring + keyid live in $BK (parent); only $OFFSITE is exposed to the NAS pull.
# NOTE: the default deliberately points at the momsbest backup root — that dir
# already holds the shared GPG keyring and is the box's single NAS-pulled
# offsite tree. The production cron runs with exactly this path; do NOT change
# the default without migrating the keyring and the NAS rrsync config.
BK="${SINNLOS_BACKUP_DIR:-/home/bigemo/backups/momsbest}"
OFFSITE="$BK/offsite/sinnlos"
export GNUPGHOME="${SINNLOS_GNUPGHOME:-$BK/.gnupg}"
KEYID_FILE="${SINNLOS_BACKUP_KEYID:-$BK/.backup-keyid}"
LOG="$OFFSITE/backup.log"
RETENTION_DAYS=7
RETENTION_KEEP=7
RETENTION_VICTIMS=()

KIND="${SINNLOS_BACKUP_KIND:-nightly}"
case "$KIND" in
  nightly) TAG="" ;;
  predeploy) TAG="-predeploy" ;;
  *)
    echo "pg-backup: SINNLOS_BACKUP_KIND must be nightly or predeploy, not '$KIND'" >&2
    exit 2
    ;;
esac
# last-success for the nightly runs, last-success-predeploy for the others.
LAST_SUCCESS="$OFFSITE/last-success$TAG"

# The offsite dirs, created level by level (0700). One that root creates
# (deploy.sh's pre-deploy run on a new host or backup dir, before the first
# nightly run) gets the owner of the backup root, who holds the keyring and
# runs the cron: a root-owned offsite dir would lock that cron out, and
# own_like_offsite would hand root's ownership on to every artifact.
# Existing dirs keep their owner. The backup root itself must exist.
if [[ ! -d "$BK" ]]; then
  echo "pg-backup: the backup root $BK does not exist (it holds the GPG keyring and .backup-keyid)" >&2
  exit 1
fi
for d in "$BK/offsite" "$OFFSITE"; do
  if [[ ! -d "$d" ]]; then
    mkdir "$d"
    chmod 700 "$d"
    if ((EUID == 0)); then chown --reference="$BK" "$d" 2>/dev/null || true; fi
  fi
done
chmod 700 "$OFFSITE"
# Timestamps come from bash's printf (strftime in the process zone, like
# date(1)), which forks nothing.
printf -v TS '%(%Y%m%d-%H%M%S)T' -1

# Files this run writes that must not survive it (see the EXIT trap).
OUT="" UOUT="" EOUT="" PARTIAL="" TRIM_TMP=""
STEP="start"
FAILED_LINE=""

# A file root creates here (deploy.sh runs this as root, the cron as the
# offsite dir's owner) gets that owner, or the owner's next run could not
# read or rewrite it. Never fails the run.
own_like_offsite() {
  if ((EUID == 0)); then
    chown --reference="$OFFSITE" "$@" 2>/dev/null || true
  fi
}

[[ -e "$LOG" ]] || { : > "$LOG"; own_like_offsite "$LOG"; }
# The time as `date -Is` prints it (2026-09-29T03:00:12+02:00), in ISO_NOW.
iso_now() {
  printf -v ISO_NOW '%(%Y-%m-%dT%H:%M:%S%z)T' -1
  ISO_NOW="${ISO_NOW:0:22}:${ISO_NOW:22}"
}
log_line() { iso_now; echo "$ISO_NOW $*" >> "$LOG"; }

on_exit() {
  local rc=$?
  rm -f -- ${OUT:+"$OUT" "$OUT.gz"} ${UOUT:+"$UOUT" "$UOUT.gz"} ${EOUT:+"$EOUT" "$EOUT.gz"} \
    ${PARTIAL:+"$PARTIAL"} ${TRIM_TMP:+"$TRIM_TMP"}
  if [[ "$rc" != "0" ]]; then
    log_line "FAIL $KIND $STEP${FAILED_LINE:+ line $FAILED_LINE} (exit $rc)" 2>/dev/null || true
    echo "pg-backup: FAILED at $STEP (exit $rc); the plaintext of this run is removed" >&2
  fi
}
trap on_exit EXIT
trap 'FAILED_LINE=$LINENO' ERR
# Signals end the run through `exit`, so the EXIT trap cleans up.
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Plaintext that a killed run left behind (SIGKILL, the OOM killer: no trap
# runs then): this script's own names in the backup root, older than 60
# minutes, so a run going on right now is never meant. Reported in
# backup.log and on stderr on every run until someone deletes it; removing
# it is the owner's call.
report_stale_plaintext() {
  local path name re='^sinnlos-(db|uploads|env)-[0-9]{8}-[0-9]{6}(-predeploy)?\.(dump|tar|env)(\.gz)?$'
  while IFS= read -r path; do
    name="${path##*/}"
    [[ "$name" =~ $re ]] || continue
    case "${BASH_REMATCH[1]}.${BASH_REMATCH[3]}" in
      db.dump | uploads.tar | env.env) ;;
      *) continue ;;
    esac
    log_line "WARN stale plaintext $name (left by a killed run; review and delete it)"
    echo "pg-backup: WARNING: stale plaintext $BK/$name (left by a killed run; review and delete it)" >&2
  done < <(find "$BK" -maxdepth 1 -type f -name 'sinnlos-*' -mmin +60 2> /dev/null || true)
}
report_stale_plaintext

# Sets RETENTION_VICTIMS to the artifacts of one series that retention
# removes (paths): named <stem>-<YYYYmmdd-HHMMSS><tag>.<ext>.gz.gpg in <dir>,
# older than <cutoff> (a timestamp in the same format) AND not among the
# newest RETENTION_KEEP. Other files, the other kind's artifacts included,
# are never listed.
retention_victims() {  # <dir> <stem> <ext> <tag> <cutoff>
  local dir="$1" stem="$2" ext="$3" tag="$4" cutoff="$5" re path i rank=0
  local -a names=()
  RETENTION_VICTIMS=()
  re="^${stem}-[0-9]{8}-[0-9]{6}${tag}\\.${ext}\\.gz\\.gpg\$"
  # Pathname expansion sorts its results, and the names of one series differ
  # only in their fixed-width timestamps: oldest first.
  for path in "$dir/$stem-"*".$ext.gz.gpg"; do
    if [[ "${path##*/}" =~ $re ]]; then names+=("${path##*/}"); fi
  done
  for ((i = ${#names[@]} - 1; i >= 0; i--)); do
    rank=$((rank + 1))
    if ((rank > RETENTION_KEEP)) && [[ "${names[i]:${#stem}+1:15}" < "$cutoff" ]]; then
      RETENTION_VICTIMS+=("$dir/${names[i]}")
    fi
  done
}

# gzip $1, encrypt it into $OFFSITE, drop the plaintext, prune its series, log.
finalize() {  # <file(uncompressed)> <stem> <ext> <label>
  local f="$1" stem="$2" ext="$3" label="$4" target size now cutoff tag victim
  target="$OFFSITE/${f##*/}.gz.gpg"
  gzip -f "$f"
  PARTIAL="$OFFSITE/.${target##*/}.partial"
  gpg --homedir "$GNUPGHOME" --batch --yes --trust-model always \
      --encrypt --recipient "$KEYID" --output "$PARTIAL" "$f.gz"
  [[ -s "$PARTIAL" ]] || { echo "pg-backup: gpg wrote nothing for $label" >&2; return 1; }
  chmod 600 "$PARTIAL"
  own_like_offsite "$PARTIAL"
  mv -f "$PARTIAL" "$target"
  PARTIAL=""
  rm -f "$f.gz"
  size="$(du -h "$target")"
  log_line "ok $label ${target##*/} ${size%%[[:space:]]*}"
  # Prune only now, after this artifact's encryption succeeded: both series
  # of this stem, each by itself.
  printf -v now '%(%s)T' -1
  printf -v cutoff '%(%Y%m%d-%H%M%S)T' "$((now - RETENTION_DAYS * 86400))"
  for tag in "" "-predeploy"; do
    retention_victims "$OFFSITE" "$stem" "$ext" "$tag" "$cutoff"
    ((${#RETENTION_VICTIMS[@]})) || continue
    for victim in "${RETENTION_VICTIMS[@]}"; do
      rm -f -- "$victim"
      log_line "pruned $label ${victim##*/}"
    done
  done
}

STEP="keyid"
KEYID="$(cat "$KEYID_FILE")"

# ---- Postgres ----
STEP="sinnlos-db"
OUT="$BK/sinnlos-db-$TS$TAG.dump"
PU=$(docker exec "$DB_C" printenv POSTGRES_USER)
PD=$(docker exec "$DB_C" printenv POSTGRES_DB)
docker exec "$DB_C" pg_dump -U "$PU" -d "$PD" -Fc --no-owner > "$OUT"
docker exec -i "$DB_C" pg_restore --list < "$OUT" >/dev/null   # integrity check
finalize "$OUT" sinnlos-db dump sinnlos-db
DB_ARTIFACT="sinnlos-db-$TS$TAG.dump.gz.gpg"

# ---- Strapi uploads ----
STEP="sinnlos-uploads"
if docker volume inspect "$UPLOADS_VOL" >/dev/null 2>&1; then
  UOUT="$BK/sinnlos-uploads-$TS$TAG.tar"
  docker run --rm -v "$UPLOADS_VOL":/u:ro alpine tar -cf - -C /u . > "$UOUT"
  finalize "$UOUT" sinnlos-uploads tar sinnlos-uploads
else
  log_line "skip sinnlos-uploads volume $UPLOADS_VOL not found"
fi

# ---- infra/.env ----
# The compose env file is gitignored and holds every secret (Strapi keys,
# INTERNAL_UPLOAD_TOKEN, ...) — the DB/uploads dumps above don't cover it,
# and losing it would be unrecoverable. Encrypted copy goes offsite (same key
# and retention as the dumps). The plaintext quick-access copy in
# ~bigemo/.sinnlos-env-backup is refreshed with `cat >` so the existing inode
# keeps its bigemo/600 ownership regardless of who runs the script (cron as
# bigemo, deploy.sh as root); it is only refreshed, never created, so a root
# run can't leave a root-owned secret file behind.
STEP="sinnlos-env"
ENV_SRC="${SINNLOS_ENV_FILE:-/home/bigemo/git/sinnlos/infra/.env}"
LOCAL_ENV_BK="${SINNLOS_LOCAL_ENV_BACKUP:-/home/bigemo/.sinnlos-env-backup/.env}"
if [[ -f "$ENV_SRC" ]]; then
  EOUT="$BK/sinnlos-env-$TS$TAG.env"
  cat "$ENV_SRC" > "$EOUT"
  finalize "$EOUT" sinnlos-env env sinnlos-env
  if [[ -f "$LOCAL_ENV_BK" ]]; then
    cat "$ENV_SRC" > "$LOCAL_ENV_BK"
  else
    log_line "skip sinnlos-env quick-access copy $LOCAL_ENV_BK absent (only refreshed, never created)"
  fi
else
  log_line "skip sinnlos-env $ENV_SRC not found"
fi

# ---- last success ----
# For an external monitor: the time of the last complete run of this kind,
# the kind and its database artifact (last-success: nightly runs only, see
# the header). Refreshed in place (`cat >`-style `>`), so the file keeps its
# owner.
STEP="last-success"
[[ -e "$LAST_SUCCESS" ]] || { : > "$LAST_SUCCESS"; own_like_offsite "$LAST_SUCCESS"; }
iso_now
echo "$ISO_NOW $KIND $DB_ARTIFACT" > "$LAST_SUCCESS"
log_line "done $KIND"

# Keep the log bounded — it lives in the NAS-replicated offsite dir and would
# otherwise grow forever. The last 500 lines cover months of nightly runs.
# Truncate in place: `cat "$tmp" > "$LOG"` overwrites the existing file's
# contents WITHOUT replacing its inode, so the log keeps its original
# owner/permissions no matter who runs the script (deploy.sh as root, cron as
# bigemo). A `tail > tmp && mv` would instead swap in a new inode owned by the
# caller and break the other caller's append. The scratch file comes from
# mktemp (defaults to $TMPDIR/tmp), i.e. outside the NAS-pulled offsite tree.
STEP="log-trim"
if [[ -f "$LOG" ]]; then
  TRIM_TMP=$(mktemp)
  tail -n 500 "$LOG" > "$TRIM_TMP" && cat "$TRIM_TMP" > "$LOG" && rm -f "$TRIM_TMP"
  TRIM_TMP=""
fi
STEP="done"
