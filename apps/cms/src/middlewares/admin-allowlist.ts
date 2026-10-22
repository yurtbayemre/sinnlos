/**
 * Global gate on the Strapi admin panel and its APIs (v0.26, M5): a client
 * outside ADMIN_ALLOW_CIDRS gets a 403 before any admin route runs. Strapi CE
 * has no second factor for panel accounts, and daily work happens in the web
 * (/manage), so a fresh install keeps the panel closed from outside.
 *
 * The client is `ctx.ip`: with `server.proxy.koa` (config/server.ts, FX11)
 * the leftmost X-Forwarded-For entry the edge wrote, else the socket peer.
 * That holds only while the edge overwrites a client-supplied header (Caddy,
 * the documented Traefik entrypoint); a container on the shared Traefik
 * network that reaches the cms directly can forge it (IN04), like the login
 * throttles. This is a client-network rule, not a network boundary.
 *
 * ADMIN_ALLOW_CIDRS: comma list of IPv4/IPv6 CIDRs (address/prefix). Unset,
 * empty or blank: loopback only (127.0.0.0/8, ::1/128): local development
 * and infra/admin-tunnel.sh's forwarder inside the container still reach the
 * panel, every client behind an edge does not. A malformed entry fails the
 * boot; a /0 entry (open to everyone) logs a warning.
 *
 * The roots are the admin route prefixes Strapi 5.58 mounts (the panel's own
 * /admin/content-api/* included under /admin; review-workflows and
 * content-releases are EE-gated but listed so the gate stays whole), checked
 * on segment boundaries, case-insensitively (Strapi's router matches
 * `/ADMIN/init`), on the raw and the once-decoded path, normalised like
 * middlewares/auth-path-guard.ts. `/uploads` (the file bytes) and the content
 * API under /api are not admin paths.
 */
import { BlockList, isIP } from "node:net";
import { posix } from "node:path";

export const ADMIN_ROOTS = [
  "/admin",
  "/upload",
  "/email",
  "/content-manager",
  "/content-type-builder",
  "/users-permissions",
  "/i18n",
  "/review-workflows",
  "/content-releases",
] as const;

export const DEFAULT_ADMIN_ALLOW_CIDRS = "127.0.0.0/8,::1/128";

/** True when `rawPath` is an admin root or lies under one, in any spelling the router accepts. */
export function isAdminPath(rawPath: string): boolean {
  const forms = [rawPath];
  try {
    forms.push(decodeURIComponent(rawPath));
  } catch {
    // Malformed %-escape: only the raw form is checked (the router cannot
    // match it either).
  }
  return forms.some((form) => {
    const norm = posix.normalize(form.replace(/\\/g, "/")).toLowerCase();
    return ADMIN_ROOTS.some((root) => norm === root || norm.startsWith(`${root}/`));
  });
}

export interface AdminAllowList {
  /** The CIDRs in effect (the default when none were given). */
  cidrs: string[];
  /** A /0 entry: every client of that family is allowed. */
  open: boolean;
  allows(ip: string): boolean;
}

/** Parses ADMIN_ALLOW_CIDRS; throws on a malformed entry (the boot must fail). */
export function parseAdminAllowList(value: string | undefined): AdminAllowList {
  const raw = value?.trim() ? value : DEFAULT_ADMIN_ALLOW_CIDRS;
  const list = new BlockList();
  const cidrs: string[] = [];
  let open = false;
  for (const entry of raw.split(",").map((part) => part.trim())) {
    const match = /^([^/\s]+)\/(\d{1,3})$/.exec(entry);
    const family = match ? isIP(match[1]) : 0;
    const prefix = match ? Number(match[2]) : NaN;
    if (!match || family === 0 || prefix > (family === 4 ? 32 : 128)) {
      throw new Error(
        `ADMIN_ALLOW_CIDRS: "${entry}" is not an IPv4 or IPv6 CIDR (address/prefix, e.g. 203.0.113.0/24)`,
      );
    }
    list.addSubnet(match[1], prefix, family === 4 ? "ipv4" : "ipv6");
    cidrs.push(entry);
    if (prefix === 0) open = true;
  }
  return {
    cidrs,
    open,
    allows(ip: string): boolean {
      // ::ffff:203.0.113.9 (an IPv4 client on a dual-stack socket) is the IPv4 address.
      const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
      const address = mapped ? mapped[1] : ip;
      const family = isIP(address);
      if (family === 0) return false;
      return list.check(address, family === 4 ? "ipv4" : "ipv6");
    },
  };
}

interface GateContext {
  path?: string;
  ip?: string;
  method?: string;
  status?: number;
  body?: unknown;
}

interface GateStrapi {
  log: { info(msg: string): void; warn(msg: string): void };
}

export default (config: { allow?: string } | undefined, { strapi }: { strapi: GateStrapi }) => {
  const allowList = parseAdminAllowList(config?.allow);
  if (allowList.open) {
    strapi.log.warn(
      `[admin-allowlist] ADMIN_ALLOW_CIDRS=${allowList.cidrs.join(",")} opens the Strapi admin panel to every client`,
    );
  }
  return async (ctx: GateContext, next: () => Promise<unknown>) => {
    if (!isAdminPath(ctx.path || "") || allowList.allows(ctx.ip || "")) return next();
    strapi.log.info(`[admin-allowlist] refused ${ctx.method} ${ctx.path} from ${ctx.ip}`);
    ctx.status = 403;
    ctx.body = {
      data: null,
      error: {
        status: 403,
        name: "ForbiddenError",
        message: "The admin panel is not available from this network (ADMIN_ALLOW_CIDRS)",
      },
    };
  };
};
