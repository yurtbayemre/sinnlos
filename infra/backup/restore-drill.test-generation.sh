# shellcheck shell=bash
#
# Builds backup-run generations for infra/backup/restore-drill.test.ts
# (sourced by its harnesses, never run on a host), in the layout of
# srv-prod-01-ops' backup-run: <component>.zst.age per component, MANIFEST
# (key=value lines, plain.<component>.bytes and .sha256, then sha256sum
# lines for every other file) and COMPLETE (written last, naming the
# directory).

# Plaintext components in <dir>: db.dump is left to the caller; uploads.tar
# (two files, paths relative to the volume root), config.tar (the checkout's
# infra/.env, paths relative to /, with JWT_SECRET=drill-secret-value) and
# db-globals.sql.
make_plain() { # <dir>
  local dir="$1" root
  root="$(mktemp -d)"
  mkdir -p "${dir}" "${root}/u/avatars" "${root}/c/home/bigemo/git/sinnlos/infra"
  echo png >"${root}/u/avatars/a.png"
  echo pdf >"${root}/u/b.pdf"
  tar -cf "${dir}/uploads.tar" -C "${root}/u" .
  printf 'DATABASE_PASSWORD=drill-db-password\nJWT_SECRET=drill-secret-value\n# a comment\n' \
    >"${root}/c/home/bigemo/git/sinnlos/infra/.env"
  tar -cf "${dir}/config.tar" -C "${root}/c" home/bigemo/git/sinnlos/infra/.env
  printf 'SET default_transaction_read_only = off;\nCREATE ROLE sinnlos;\nALTER ROLE sinnlos WITH SUPERUSER;\n' \
    >"${dir}/db-globals.sql"
  rm -rf "${root}"
}

# A hostile config.tar in <dir>: the .env, a member whose name is a GNU tar
# option that runs `touch drill-proof.env` in the working directory, and
# filler beyond 10 records so that a checkpoint fires (Codex review of PR
# #68, finding 1).
make_hostile_config() { # <dir>
  local dir="$1" root
  root="$(mktemp -d)"
  mkdir -p "${root}/home/bigemo/git/sinnlos/infra"
  printf 'JWT_SECRET=drill-secret-value\nAPP_KEYS=a,b\n' >"${root}/home/bigemo/git/sinnlos/infra/.env"
  : >"${root}/--checkpoint-action=exec=touch drill-proof.env"
  head -c 300000 /dev/zero >"${root}/filler.bin"
  tar -cf "${dir}/config.tar" -C "${root}" -- home/bigemo/git/sinnlos/infra/.env \
    "--checkpoint-action=exec=touch drill-proof.env" filler.bin
  rm -rf "${root}"
}

# A generation of the four components in <plain dir>; each one goes through
# the caller's `encrypt` (stdin to stdout: zstd, then age).
make_generation() { # <generation dir> <plain dir>
  local gen="$1" plain="$2" c
  mkdir -p "${gen}"
  {
    echo "service=sinnlos"
    echo "generation=${gen##*/}"
    echo "kind=${gen##*-}"
    echo "host=drill-test"
    echo "created_at=2026-10-12T18:03:45Z"
    echo "encrypted=yes"
    echo "format=<name>.zst.age is <name> compressed with zstd, then encrypted with age"
    echo "db_image=postgres:16-alpine"
    echo "db_pg_dump_version=16.15"
  } >"${gen}/MANIFEST"
  for c in config.tar db.dump db-globals.sql uploads.tar; do
    encrypt <"${plain}/${c}" >"${gen}/${c}.zst.age"
    echo "plain.${c}.bytes=$(wc -c <"${plain}/${c}" | tr -d ' ')" >>"${gen}/MANIFEST"
    echo "plain.${c}.sha256=$(sha256sum <"${plain}/${c}" | cut -d' ' -f1)" >>"${gen}/MANIFEST"
  done
  (cd "${gen}" && sha256sum -- *.zst.age) >>"${gen}/MANIFEST"
  echo "${gen##*/} 2026-10-12T18:03:50Z" >"${gen}/COMPLETE"
}

# Rewrites the sha256sum line of <file> in MANIFEST after a deliberate change.
reseal() { # <generation dir> <file>
  local gen="$1" file="$2" sum
  sum="$(sha256sum <"${gen}/${file}" | cut -d' ' -f1)"
  # sha256sum marks binary mode with " *" (Git Bash does by default).
  sed -i "s|^[0-9a-f]\{64\} [ *]${file}\$|${sum}  ${file}|" "${gen}/MANIFEST"
}
