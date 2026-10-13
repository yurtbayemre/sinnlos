# shellcheck shell=bash
#
# The slow sequence of infra/backup/restore-drill.test.ts
# (SINNLOS_SLOW_SHELL_TESTS=1): restore-drill.sh --generation with real age,
# zstd and Postgres 16. A source container rs-drill-src-<n> gives a real
# pg_dump -Fc; the generation is encrypted to a throwaway age key. The
# harness has put the script under test at $d/restore-drill.sh and sourced
# restore-drill.test-generation.sh. Results come back as "@@<case>.<what>"
# lines; the source container and $d go on exit.
: "${d:?}"
SRC="rs-drill-src-$$-${RANDOM}"
cleanup() {
  docker rm -f -v "${SRC}" >/dev/null 2>&1
  rm -rf "${d}"
}
trap cleanup EXIT

docker run -d --name "${SRC}" --network none -e POSTGRES_USER=sinnlos -e POSTGRES_PASSWORD=x \
  -e POSTGRES_DB=sinnlos postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "${SRC}" pg_isready -q -h 127.0.0.1 -U sinnlos -d sinnlos 2>/dev/null; then break; fi
  sleep 1
done
docker exec -i "${SRC}" psql -X -q -v ON_ERROR_STOP=1 -U sinnlos -d sinnlos <<'SQL'
CREATE TABLE up_users (id int PRIMARY KEY, username text);
INSERT INTO up_users SELECT g, 'user' || g FROM generate_series(1, 4) g;
CREATE TABLE posts (id int PRIMARY KEY, author int REFERENCES up_users);
INSERT INTO posts VALUES (1, 1), (2, 2), (3, 3);
SQL
mkdir -p "${d}/plain" "${d}/tmp"
docker exec "${SRC}" pg_dump -U sinnlos -d sinnlos --format=custom >"${d}/plain/db.dump"
make_plain "${d}/plain"
age-keygen -o "${d}/key.txt" 2>/dev/null
age-keygen -o "${d}/wrong.txt" 2>/dev/null
RECIPIENT="$(age-keygen -y "${d}/key.txt")"
encrypt() { zstd -q -c | age -r "${RECIPIENT}"; }
G="${d}/gen/20261012T180345Z-predeploy"
make_generation "${G}" "${d}/plain"

drill() { # <case> <generation> <identity>
  local name="$1" rc
  TMPDIR="${d}/tmp" bash "${d}/restore-drill.sh" --generation "$2" --identity "$3" \
    --name "rs-drill-${name}-$$" >"${d}/out" 2>"${d}/err"
  rc=$?
  echo "@@${name}.rc ${rc}"
  sed "s/^/@@${name}.out /" "${d}/out"
  sed "s/^/@@${name}.err /" "${d}/err"
  echo "@@${name}.left $(find "${d}/tmp" -mindepth 1 | wc -l)"
  echo "@@${name}.containers $(docker ps -aq --filter "name=rs-drill-${name}-$$" | wc -l)"
}

drill good "${G}" "${d}/key.txt"
drill wrong "${G}" "${d}/wrong.txt"
T2="${d}/gen/20261012T180345Z-daily"
cp -r "${G}" "${T2}"
echo "${T2##*/} 2026-10-12T18:03:50Z" >"${T2}/COMPLETE"
printf x >>"${T2}/uploads.tar.zst.age"
drill tampered "${T2}" "${d}/key.txt"
rm "${T2}/COMPLETE"
drill incomplete "${T2}" "${d}/key.txt"
echo "@@done 1"
