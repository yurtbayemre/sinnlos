# shellcheck shell=bash
#
# The slow sequence of infra/restore-db.test.ts (SINNLOS_SLOW_SHELL_TESTS=1):
# infra/restore-db.sh against a real Postgres 16, in a throwaway compose
# project rs-restore-<pid> with db (postgres:16-alpine, data on a tmpfs) and
# cms and web (alpine, asleep; the cms gets JWT_SECRET from infra/.env, as
# in production). The harness has put the script under test at
# $REPO/infra/restore-db.sh. Results come back as "@@<name> <value>" lines;
# the project and $T go on exit.
: "${T:?}" "${REPO:?}"
P="rs-restore-$$-${RANDOM}"
C=(docker compose -p "${P}" -f "${REPO}/infra/docker-compose.yml")
cleanup() {
  "${C[@]}" down -v --remove-orphans >/dev/null 2>&1
  rm -rf "${T}"
}
trap cleanup EXIT

cat >"${REPO}/infra/docker-compose.yml" <<'YML'
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: sinnlos
      POSTGRES_PASSWORD: ${DATABASE_PASSWORD:?DATABASE_PASSWORD must be set}
      POSTGRES_DB: sinnlos
    tmpfs:
      - /var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U sinnlos -d sinnlos"]
      interval: 1s
      retries: 60
  cms:
    image: alpine:3.20
    command: ["sleep", "86400"]
    environment:
      JWT_SECRET: ${JWT_SECRET:?JWT_SECRET must be set}
    depends_on:
      db:
        condition: service_healthy
  web:
    image: alpine:3.20
    command: ["sleep", "86400"]
YML
: >"${REPO}/infra/docker-compose.traefik.yml"
printf 'DATABASE_PASSWORD=pw\nJWT_SECRET=old-secret\n' >"${REPO}/infra/.env"
G=(git -C "${REPO}" -c user.name=restore-test -c user.email=restore-test@example.invalid
  -c commit.gpgsign=false -c init.defaultBranch=main -c core.hooksPath=/dev/null)
"${G[@]}" init -q && "${G[@]}" add -A && "${G[@]}" commit -q -m first
if ! "${C[@]}" up -d --wait >/dev/null 2>&1; then
  echo "@@fatal compose up failed"
  exit 1
fi

q() { docker exec -i "${P}-db-1" psql -X -q -tA -v ON_ERROR_STOP=1 -U sinnlos -d sinnlos "$@"; }
# One restore-db.sh step, as the runbook runs it (project and edge named).
run() { # <name> <args...>
  local name="$1" rc
  shift
  (cd "${T}" && COMPOSE_PROJECT="${P}" RESTORE_EDGE=caddy bash "${REPO}/infra/restore-db.sh" "$@") >"${T}/out" 2>"${T}/err"
  rc=$?
  echo "@@${name}.rc ${rc}"
  sed "s/^/@@${name}.out /" "${T}/out"
  sed "s/^/@@${name}.err /" "${T}/err"
}
facts() { # <name>
  echo "@@$1.tables $(q -c "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')" 2>/dev/null || echo none)"
  echo "@@$1.users $(q -c "SELECT count(*) FROM up_users" 2>/dev/null || echo none)"
  echo "@@$1.running $(docker ps --filter "label=com.docker.compose.project=${P}" --format '{{.Label "com.docker.compose.service"}}' | sort | tr '\n' ' ')"
  echo "@@$1.envsum $(sed -n 's/^JWT_SECRET=//p' "${REPO}/infra/.env" | sha256sum | cut -c1-64)"
  echo "@@$1.cmssum $(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "${P}-cms-1" | sed -n 's/^JWT_SECRET=//p' | sha256sum | cut -c1-64)"
}

# v1: the dump's schema; v2 below: a newer release with a table that
# references up_users.
q <<'SQL'
CREATE TABLE up_users (id int PRIMARY KEY, username text);
INSERT INTO up_users SELECT g, 'user' || g FROM generate_series(1, 3) g;
CREATE TABLE posts (id int PRIMARY KEY, author int REFERENCES up_users);
INSERT INTO posts VALUES (1, 1), (2, 2);
SQL
docker exec "${P}-db-1" pg_dump -U sinnlos -d sinnlos --format=custom >"${T}/v1.dump"
# A dump whose restore fails: a GRANT to a role the target does not have.
q -c "CREATE ROLE walk_reader" -c "GRANT SELECT ON up_users TO walk_reader"
docker exec "${P}-db-1" pg_dump -U sinnlos -d sinnlos --format=custom >"${T}/grant.dump"
q -c "REVOKE SELECT ON up_users FROM walk_reader" -c "DROP ROLE walk_reader"
# A dump cut off in its data: pg_dump -f (a seekable file) writes the table
# of contents first, so the cut keeps it whole.
q -c "CREATE TABLE bulk AS SELECT g AS id, md5(g::text) AS v FROM generate_series(1, 100000) g"
docker exec "${P}-db-1" pg_dump -U sinnlos -d sinnlos --format=custom -f /tmp/big.dump
docker cp "${P}-db-1:/tmp/big.dump" "${T}/big.dump" >/dev/null
size="$(stat -c %s "${T}/big.dump")"
head -c $((size * 9 / 10)) "${T}/big.dump" >"${T}/cut.dump"
docker exec -i "${P}-db-1" pg_restore --list <"${T}/cut.dump" >/dev/null 2>&1
echo "@@cut.list $?"
q -c "DROP TABLE bulk"
q <<'SQL'
CREATE TABLE rsvps (id int PRIMARY KEY, user_id int REFERENCES up_users);
INSERT INTO up_users VALUES (4, 'user4');
INSERT INTO rsvps VALUES (1, 4);
SQL
echo garbage >"${T}/garbage.dump"
facts start

# A. dumps that must not be restored
run cut prepare cut.dump
run garbage prepare garbage.dump
run missing prepare nope.dump
facts refused

# B. the older dump over the newer database, step by step
run b.prepare prepare v1.dump
run b.apply apply
run b.rotate rotate-jwt
run b.start start
facts b

# C. a createdb that fails after the drop (template1 in use), then apply again
run c.prepare prepare v1.dump
docker exec -d "${P}-db-1" psql -U sinnlos -d template1 -c "SELECT pg_sleep(60)"
sleep 2
run c.apply apply
echo "@@c.exists $(q -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = 'sinnlos'" 2>/dev/null)"
run c.start start
q -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'template1'" >/dev/null
run c.apply2 apply
facts c

# D. a restore that fails (the role is missing) and the way back
run d.prepare prepare grant.dump
run d.apply apply
facts d1
run d.back back
run d.apply2 apply
run d.rotate rotate-jwt
run d.start start
facts d2

# E. a compose file that pins the cms's JWT_SECRET, an exported JWT_SECRET,
# and the env-only pair
printf 'services:\n  cms:\n    environment:\n      JWT_SECRET: pinned-by-override\n' >"${REPO}/infra/docker-compose.traefik.yml"
(cd "${T}" && COMPOSE_PROJECT="${P}" RESTORE_EDGE=traefik bash "${REPO}/infra/restore-db.sh" rotate-jwt --env-only) >"${T}/out" 2>"${T}/err"
echo "@@e.pinned.rc $?"
sed "s/^/@@e.pinned.err /" "${T}/err"
: >"${REPO}/infra/docker-compose.traefik.yml"
run e.rotate rotate-jwt --env-only
(cd "${T}" && JWT_SECRET=old-secret COMPOSE_PROJECT="${P}" RESTORE_EDGE=caddy bash "${REPO}/infra/restore-db.sh" start --env-only) >"${T}/out" 2>"${T}/err"
echo "@@e.exported.rc $?"
sed "s/^/@@e.exported.err /" "${T}/err"
run e.start start --env-only
facts e

# F. a step while another process holds the lock (a deploy, or a second
# restore step)
(
  flock 8
  sleep 20
) 8>>"${REPO}/.git/sinnlos-deploy/${P}.lock" &
holder=$!
sleep 1
run f.locked prepare v1.dump
kill "${holder}" 2>/dev/null
wait "${holder}" 2>/dev/null
facts f
echo "@@done 1"
