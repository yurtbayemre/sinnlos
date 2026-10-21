#!/usr/bin/env bash
# provision-keys.sh — the two restricted Meilisearch keys of the optional
# search module (docs/DEPLOYMENT.md, "Meilisearch (optional search)"),
# printed as infra/.env lines:
#
#   MEILISEARCH_WRITE_KEY   cms: rebuilds sinnlos_search via sinnlos_search_build
#                           (index create/get/update/delete/swap, documents,
#                           settings, tasks). On every index: a swap task
#                           belongs to no index (indexUid null), and a key
#                           limited to sinnlos_search* gets 404 for it, so
#                           the cms could not wait for the swap. This
#                           Meilisearch serves sinnlos only.
#   MEILISEARCH_SEARCH_KEY  web: search on sinnlos_search only
#
# Usage (on the Docker host, with the meili container running):
#   COMPOSE_PROJECT=infra infra/meilisearch/provision-keys.sh
#   MEILI_CONTAINER=<name> infra/meilisearch/provision-keys.sh   # another container
#
# The calls run inside the meili container against its own loopback, with
# that container's MEILI_MASTER_KEY: the master key never leaves it and is
# never printed. The key uids are fixed, so a re-run prints the same two
# keys (Meilisearch derives a key from its uid and the master key; a new
# master key means new values: run this again and update infra/.env).
set -euo pipefail

PROJECT="${COMPOSE_PROJECT:-infra}"
CONTAINER="${MEILI_CONTAINER:-${PROJECT}-meili-1}"

docker exec -i "${CONTAINER}" sh -s <<'SH'
set -eu
if [ -z "${MEILI_MASTER_KEY:-}" ]; then
  echo "ERROR: MEILI_MASTER_KEY is empty in this container (infra/.env)" >&2
  exit 1
fi
api=http://127.0.0.1:7700
auth="Authorization: Bearer ${MEILI_MASTER_KEY}"

# key UID NAME ACTIONS INDEXES: the key value, created on the first run.
key() {
  json="$(curl -fsS -H "${auth}" "${api}/keys/$1" 2>/dev/null)" ||
    json="$(curl -fsS -X POST -H "${auth}" -H 'Content-Type: application/json' "${api}/keys" \
      --data "{\"uid\":\"$1\",\"name\":\"$2\",\"actions\":$3,\"indexes\":$4,\"expiresAt\":null}")"
  value="$(printf '%s' "${json}" | sed -n 's/.*"key":"\([^"]*\)".*/\1/p')"
  [ -n "${value}" ] || { echo "ERROR: no key in the answer for $2" >&2; exit 1; }
  printf '%s' "${value}"
}

write="$(key 4039b085-9a38-400a-9f20-769bdfe20d8d sinnlos-cms-write \
  '["indexes.create","indexes.get","indexes.update","indexes.delete","indexes.swap","documents.add","documents.delete","settings.update","settings.get","tasks.get"]' \
  '["*"]')"
search="$(key e327d53a-8d84-4c7c-8092-e97bbfb018da sinnlos-web-search '["search"]' '["sinnlos_search"]')"
echo "MEILISEARCH_WRITE_KEY=${write}"
echo "MEILISEARCH_SEARCH_KEY=${search}"
SH
echo "Put both lines into infra/.env, then MEILISEARCH_ENABLED=1 and deploy." >&2
