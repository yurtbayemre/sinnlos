#!/usr/bin/env bash
#
# admin-tunnel.sh — the Strapi admin panel through an SSH tunnel, while
# ADMIN_ALLOW_CIDRS keeps it closed from outside (docs/INSTALL.md, "Strapi
# admin panel through an SSH tunnel").
#
# On the Docker host:   infra/admin-tunnel.sh start   (and later: stop)
#
# `start` runs a small TCP forwarder INSIDE the running cms container (node,
# `docker exec -d`). It listens on the cms address of the project network
# <project>_default, port ADMIN_TUNNEL_PORT (1338), accepts connections only
# from that network's gateway (the Docker host itself, where your SSH tunnel
# ends) and forwards them to 127.0.0.1:1337, so the cms sees a loopback
# client, which its default allowlist admits. Containers on other networks
# (a shared Traefik network) cannot reach that address; other containers of
# the project are refused by the source check. The forwarder ends after
# ADMIN_TUNNEL_MINUTES (60), when the cms container restarts, or on `stop`.
# A second `start` replaces the running one.
#
# Then, on your computer, the ssh line it prints (it ends at this host):
#   ssh -N -L 1337:<cms address>:1338 <user>@<this host>
# and open http://localhost:1337/admin. Close the ssh with Ctrl-C, then
# `infra/admin-tunnel.sh stop` (or let it time out).
#
# Environment: COMPOSE_PROJECT (infra), ADMIN_TUNNEL_PORT (1338),
# ADMIN_TUNNEL_MINUTES (60), ADMIN_TUNNEL_LOCAL_PORT (1337: the port on your
# computer, only used in the printed lines).
set -Eeuo pipefail

PROJECT="${COMPOSE_PROJECT:-infra}"
CMS="${PROJECT}-cms-1"
NETWORK="${PROJECT}_default"
PORT="${ADMIN_TUNNEL_PORT:-1338}"
MINUTES="${ADMIN_TUNNEL_MINUTES:-60}"
LOCAL_PORT="${ADMIN_TUNNEL_LOCAL_PORT:-1337}"
# In the forwarder's command line, so `stop` finds it (and nothing else).
MARKER="sinnlos-admin-tunnel"

for value in "${PORT}" "${MINUTES}" "${LOCAL_PORT}"; do
  if ! [[ "${value}" =~ ^[1-9][0-9]{0,4}$ ]]; then
    echo "admin-tunnel: ADMIN_TUNNEL_PORT, ADMIN_TUNNEL_MINUTES and ADMIN_TUNNEL_LOCAL_PORT must be whole numbers: ${value}" >&2
    exit 2
  fi
done

case "${1:-}" in
  stop)
    if docker exec "${CMS}" pkill -f "${MARKER}" 2>/dev/null; then
      echo "admin-tunnel: stopped"
    else
      echo "admin-tunnel: none was running"
    fi
    exit 0
    ;;
  start) ;;
  *)
    echo "usage: infra/admin-tunnel.sh start|stop" >&2
    exit 2
    ;;
esac

address="$(docker inspect --format "{{with index .NetworkSettings.Networks \"${NETWORK}\"}}{{.IPAddress}}{{end}}" "${CMS}" 2>/dev/null || true)"
gateway="$(docker network inspect --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}' "${NETWORK}" 2>/dev/null || true)"
gateway="${gateway%% *}"
if [[ -z "${address}" || -z "${gateway}" ]]; then
  echo "admin-tunnel: ${CMS} is not running on the network ${NETWORK} (COMPOSE_PROJECT=${PROJECT})" >&2
  exit 1
fi

# The forwarder (runs in the cms container; argv: marker, address, port, gateway, minutes).
FORWARDER='
const net = require("net");
const [, , address, port, gateway, minutes] = process.argv;
net
  .createServer((client) => {
    if ((client.remoteAddress || "").replace(/^::ffff:/, "") !== gateway) return client.destroy();
    const cms = net.connect(1337, "127.0.0.1");
    client.on("error", () => cms.destroy());
    cms.on("error", () => client.destroy());
    client.pipe(cms).pipe(client);
  })
  .listen(Number(port), address);
setTimeout(() => process.exit(0), Number(minutes) * 60000);
'

docker exec "${CMS}" pkill -f "${MARKER}" >/dev/null 2>&1 || true
docker exec -d "${CMS}" node -e "${FORWARDER}" "${MARKER}" "${address}" "${PORT}" "${gateway}" "${MINUTES}"

# Up within a few seconds? (A connection from inside the container is
# accepted by the socket, then dropped by the source check: enough to tell.)
for _ in 1 2 3 4 5; do
  if docker exec "${CMS}" node -e \
    'require("net").connect(Number(process.argv[2]), process.argv[1]).on("connect", () => process.exit(0)).on("error", () => process.exit(1))' \
    "${address}" "${PORT}" >/dev/null 2>&1; then
    echo "admin-tunnel: open for ${MINUTES} minutes (${CMS} ${address}:${PORT}, from this host only)"
    echo "  On your computer:  ssh -N -L ${LOCAL_PORT}:${address}:${PORT} <user>@<this host>"
    echo "  Then open:         http://localhost:${LOCAL_PORT}/admin"
    echo "  Close it:          infra/admin-tunnel.sh stop"
    exit 0
  fi
  sleep 1
done
echo "admin-tunnel: the forwarder in ${CMS} did not start listening on ${address}:${PORT}" >&2
exit 1
