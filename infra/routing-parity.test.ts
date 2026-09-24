/**
 * Routing parity between the two reverse-proxy configs (issue #22, S10).
 *
 * The path routing exists TWICE by design: the Traefik labels in
 * docker-compose.traefik.yml are what production (VPS, host Traefik) uses,
 * the Caddyfile is the fallback/standalone profile. §1 of
 * docs/architecture.md declares the two synchronized — but nothing enforced
 * it, and the drift was real: /upload + /email were added to the Traefik
 * labels only (commit 91a305a), so a Caddy deploy would have re-triggered
 * the media-library crash of 2026-08-15 (admin XHRs answered with a
 * sign-in redirect instead of JSON).
 *
 * This test parses BOTH files into small models of the real proxies and
 * asserts:
 *  1. the set of first path segments routed to cms is identical and equals
 *     the canonical list below,
 *  2. ALL Traefik routers with their load-bearing priorities (auth 100 >
 *     signin 90 > cms 50 > web 1): /api/auth/* and POST /sign-in|/register
 *     must win over the cms /api rule and the catch-all,
 *  3. the Caddy route order as Caddy computes it — @nextauth must stay
 *     before @strapi in the FILE (see caddySortedRoutes),
 *  4. a probe table of concrete requests routes identically under both
 *     proxies — including the issue-#21 invariant that /uploads/* file bytes
 *     go to web (session-gated route), while /upload (media-library admin
 *     API) still goes to cms,
 *  5. where the proxies DIFFER (case variants, traversal, exact-vs-prefix),
 *     each difference is pinned explicitly instead of being ignored,
 *  6. security-header parity between the Traefik headers middleware and the
 *     Caddyfile header block, with the current gaps listed (FX33).
 *
 * Matching semantics differ between the proxies and are modelled here:
 *  - Traefik (v3 rule syntax): `PathPrefix(`/x`)` is a RAW, case-sensitive
 *    string prefix — `/email` matches `/emailXYZ` (verified against the live
 *    Traefik 3.7 on 2026-08-17). `Path(`/x`)` is an exact match. The path is
 *    matched as received: no dot-segment cleaning, so `/api/../uploads/x`
 *    matches the /api prefix (live-verified, see TRAVERSAL below). The
 *    highest-priority matching router wins. That is why the cms rule needs
 *    the segment-exact `Path(`/upload`) || PathPrefix(`/upload/`)` pair: a
 *    bare `PathPrefix(`/upload`)` would keep swallowing `/uploads`.
 *  - Caddy `path` matcher (caddyhttp MatchPath): the request path is
 *    percent-DECODED, LOWERCASED and cleaned (dot segments resolved, slashes
 *    merged) before matching; patterns are lowercased too. A trailing `*` is
 *    a raw prefix (`/admin*`), `/x/*` a segment prefix, no `*` an exact
 *    match. Several `reverse_proxy` routes are ordered by Caddy's sortRoutes
 *    (httpcaddyfile), and the first matching one handles the request.
 */
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The canonical first-segment list routed to cms. Deliberately duplicated
 * from both config files: the whole point is that a drift in EITHER file
 * fails loudly here instead of surfacing as a broken media library or —
 * worse — anonymously served upload bytes. `uploads` must never appear
 * (issue #21: file bytes are served by the session-gated web route).
 */
const CMS_PREFIXES = [
  "admin",
  "api",
  "content-api",
  "content-manager",
  "content-type-builder",
  "email",
  "i18n",
  "upload",
  "users-permissions",
].sort();

/**
 * Router name → priority. Load-bearing (roadmap "Do not touch without
 * care"): auth must beat the cms /api rule, and the sign-in POST router must
 * beat the catch-all so its tighter rate limit applies. Any new router must
 * be added here consciously.
 */
const TRAEFIK_ROUTER_PRIORITIES: Record<string, number> = {
  "sinnlos-auth": 100,
  "sinnlos-signin": 90,
  "sinnlos-cms": 50,
  "sinnlos-web": 1,
};

type Backend = "cms" | "web";
type Method = "GET" | "POST";

/** [method, path, backend] — identical under BOTH proxies. */
const PROBES: Array<[Method, string, Backend]> = [
  // Issue #21: upload BYTES are session-gated in web…
  ["GET", "/uploads/large_photo_abc123.webp", "web"],
  ["GET", "/uploads/document_9f8e7d.pdf", "web"],
  ["GET", "/uploads", "web"],
  // …while the media-library ADMIN API stays on cms (the 2026-08-15 crash
  // was exactly these XHRs falling through to the web catch-all).
  ["GET", "/upload", "cms"],
  ["POST", "/upload", "cms"],
  ["GET", "/upload/files", "cms"],
  ["POST", "/upload/actions/bulk-delete", "cms"],
  // Regression for the raw-prefix landmine: an /upload-prefixed segment
  // that is NOT /upload itself belongs to web.
  ["GET", "/uploadsomething", "web"],
  // The #22 drift paths.
  ["GET", "/email/settings", "cms"],
  // Rest of the Strapi surface.
  ["GET", "/api/classifieds", "cms"],
  ["GET", "/admin", "cms"],
  ["GET", "/admin/plugins", "cms"],
  ["GET", "/content-manager/collection-types/api::classified.classified", "cms"],
  ["GET", "/content-type-builder/content-types", "cms"],
  ["GET", "/users-permissions/roles", "cms"],
  ["GET", "/i18n/locales", "cms"],
  ["GET", "/content-api/permissions", "cms"],
  // Auth.js lives under /api/auth/* on web and must win over the cms /api
  // rule (Traefik: priority 100 > 50; Caddy: @nextauth before @strapi).
  ["GET", "/api/auth/session", "web"],
  ["GET", "/api/auth/csrf", "web"],
  ["GET", "/api/auth/providers", "web"],
  ["GET", "/api/auth/callback/microsoft-entra-id", "web"],
  ["POST", "/api/auth/callback/local", "web"],
  ["POST", "/api/auth/signout", "web"],
  // Strapi's own local-auth endpoints are shadowed by the Auth.js prefix:
  // they are NOT reachable from outside (case variants: see CASE_PROBES).
  ["POST", "/api/auth/local", "web"],
  ["POST", "/api/auth/local/register", "web"],
  // Web app stays on web — including the sign-in/register form POSTs.
  ["GET", "/", "web"],
  ["GET", "/sign-in", "web"],
  ["POST", "/sign-in", "web"],
  ["GET", "/register", "web"],
  ["POST", "/register", "web"],
  ["GET", "/marketplace", "web"],
  ["GET", "/documents", "web"],
  ["GET", "/events/abc123/ics", "web"],
  // Live SSE (issue #17/#27): the stream + subscribe endpoints live
  // OUTSIDE /api on purpose so they reach the web catch-all…
  ["GET", "/live/stream", "web"],
  ["POST", "/live/subscribe", "web"],
  // …while the internal CMS→web ingests are EXTERNALLY swallowed by the cms
  // /api rule (no such Strapi route → 404). Only the Docker-internal
  // http://web:3000 path reaches the real handlers; these probes pin that
  // external unreachability.
  ["POST", "/api/live/emit", "cms"],
  ["POST", "/api/revalidate", "cms"],
];

/** [method, path, router] — which Traefik router must win (priorities). */
const TRAEFIK_ROUTER_PROBES: Array<[Method, string, string]> = [
  ["GET", "/api/auth/session", "sinnlos-auth"],
  ["POST", "/api/auth/callback/local", "sinnlos-auth"],
  ["GET", "/api/auth/callback/microsoft-entra-id", "sinnlos-auth"],
  // POST-only router: the sign-in/register Server Action POSTs get the
  // tighter edge rate limit (issue #23)…
  ["POST", "/sign-in", "sinnlos-signin"],
  ["POST", "/register", "sinnlos-signin"],
  // …while the GET renders and look-alike paths stay on the catch-all.
  ["GET", "/sign-in", "sinnlos-web"],
  ["GET", "/register", "sinnlos-web"],
  ["POST", "/sign-in/x", "sinnlos-web"],
  ["POST", "/sign-in2", "sinnlos-web"],
  ["GET", "/api/classifieds", "sinnlos-cms"],
  ["POST", "/api/live/emit", "sinnlos-cms"],
  ["GET", "/admin", "sinnlos-cms"],
  ["GET", "/", "sinnlos-web"],
  ["GET", "/uploads/document_9f8e7d.pdf", "sinnlos-web"],
];

/**
 * Case variants: Traefik matches case-SENSITIVELY, Caddy lowercases. Pinned
 * so the divergence stays visible. [path, Traefik backend, Caddy backend].
 */
const CASE_PROBES: Array<[string, Backend, Backend]> = [
  // D-EDGE-01: Traefik sends `/api/Auth/local` to cms — it misses the
  // case-sensitive /api/auth prefix but hits /api — and Strapi's router
  // matches case-INsensitively, so this reaches Strapi's local login that
  // the lowercase shape (PROBES) shadows. The block belongs on the cms side;
  // this probe documents the edge behaviour it has to cover.
  ["/api/Auth/local", "cms", "web"],
  ["/API/AUTH/session", "web", "web"],
  // Upper-case Strapi prefixes miss every Traefik cms token (→ web catch-all,
  // a Next 404) but reach Strapi under Caddy.
  ["/API/classifieds", "web", "cms"],
  ["/Admin", "web", "cms"],
  ["/UPLOAD/files", "web", "cms"],
  // Upload bytes stay on web under both, whatever the case.
  ["/Uploads/document_9f8e7d.pdf", "web", "web"],
];

/**
 * Traversal side channel (issue #21 / review fix K1). Traefik matches the RAW
 * path, so `/api/../uploads/x` and its percent-encoded twins are routed to
 * cms by the `/api`|`/admin` prefix — around the web session gate — and cms
 * then serves the bytes (koa-static resolves the `..` back into
 * public/uploads). Verified live against prod on 2026-08-17: every shape
 * below returned the %PDF bytes ANONYMOUSLY. Moving `/uploads` to web at the
 * edge therefore does NOT close the hole; the routing-independent cms token
 * gate (apps/cms/src/middlewares/uploads-auth.ts) is the actual protection.
 * Caddy cleans the decoded path first, so it sends these to web — but
 * production runs Traefik, and the gate must hold under either proxy.
 */
const TRAVERSAL: string[] = [
  "/api/%2e%2e/uploads/document_9f8e7d.pdf",
  "/api/../uploads/document_9f8e7d.pdf",
  "/admin/%2e%2e/uploads/document_9f8e7d.pdf",
];

/**
 * Known, tolerated exact-vs-prefix differences: no real endpoint lives on
 * these shapes. [path, Traefik backend, Caddy backend].
 */
const KNOWN_DIFFERENCES: Array<[string, Backend, Backend]> = [
  // Traefik PathPrefix(`/api`) is raw; Caddy `/api/*` needs the slash.
  ["/api", "cms", "web"],
  ["/emailXYZ", "cms", "web"],
  // Bare /api/auth: Traefik's auth prefix is raw, Caddy's @nextauth needs
  // `/api/auth/`, so Caddy falls through to @strapi `/api/*`.
  ["/api/auth", "web", "cms"],
  ["/api/authx", "web", "cms"],
];

/**
 * Security headers the Traefik headers middleware sets but the Caddyfile
 * header block does not (FX33 adds them to Caddy). Closing a gap must remove
 * it from this list; a NEW gap fails the parity test.
 */
const KNOWN_CADDY_HEADER_GAPS = [
  "permissions-policy",
  "strict-transport-security",
  "x-frame-options",
].sort();

function readInfraFile(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// Traefik model
// ---------------------------------------------------------------------------

interface ProbeRequest {
  host: string;
  method: Method;
  path: string;
}

type MatcherNode = { kind: "matcher"; name: TraefikMatcher; value: string };
type RuleNode =
  | { kind: "and" | "or"; left: RuleNode; right: RuleNode }
  | { kind: "not"; operand: RuleNode }
  | MatcherNode;

const TRAEFIK_MATCHERS = ["Host", "Path", "PathPrefix", "Method"] as const;
type TraefikMatcher = (typeof TRAEFIK_MATCHERS)[number];

function isTraefikMatcher(name: string): name is TraefikMatcher {
  return (TRAEFIK_MATCHERS as readonly string[]).includes(name);
}

interface RuleToken {
  type: "op" | "ident" | "string";
  text: string;
}

function tokenizeRule(rule: string): RuleToken[] {
  const tokens: RuleToken[] = [];
  let i = 0;
  while (i < rule.length) {
    const rest = rule.slice(i);
    const space = rest.match(/^\s+/);
    if (space) {
      i += space[0].length;
      continue;
    }
    const op = rest.match(/^(&&|\|\||!|\(|\)|,)/);
    if (op) {
      tokens.push({ type: "op", text: op[1] });
      i += op[1].length;
      continue;
    }
    const ident = rest.match(/^[A-Za-z]+/);
    if (ident) {
      tokens.push({ type: "ident", text: ident[0] });
      i += ident[0].length;
      continue;
    }
    const str = rest.match(/^`([^`]*)`/);
    if (str) {
      tokens.push({ type: "string", text: str[1] });
      i += str[0].length;
      continue;
    }
    throw new Error(`cannot tokenize Traefik rule at "${rest}"`);
  }
  return tokens;
}

/**
 * Recursive-descent parser for the Traefik v3 rule subset used here
 * (`&&`, `||`, `!`, parentheses; Host/Path/PathPrefix/Method with one
 * argument). Any other matcher (PathRegexp, Header, …) throws, so the model
 * is extended consciously instead of silently mis-routing.
 */
function parseTraefikRule(rule: string): RuleNode {
  const tokens = tokenizeRule(rule);
  let pos = 0;
  const take = (text?: string): RuleToken => {
    const token = tokens[pos++];
    if (!token || (text !== undefined && token.text !== text)) {
      throw new Error(`expected ${text ?? "a token"} in Traefik rule: ${rule}`);
    }
    return token;
  };
  const parseOr = (): RuleNode => {
    let left = parseAnd();
    while (tokens[pos]?.text === "||") {
      pos++;
      left = { kind: "or", left, right: parseAnd() };
    }
    return left;
  };
  const parseAnd = (): RuleNode => {
    let left = parseUnary();
    while (tokens[pos]?.text === "&&") {
      pos++;
      left = { kind: "and", left, right: parseUnary() };
    }
    return left;
  };
  const parseUnary = (): RuleNode => {
    if (tokens[pos]?.text === "!") {
      pos++;
      return { kind: "not", operand: parseUnary() };
    }
    const token = take();
    if (token.type === "op" && token.text === "(") {
      const inner = parseOr();
      take(")");
      return inner;
    }
    if (token.type === "ident") {
      if (!isTraefikMatcher(token.text)) {
        throw new Error(`unmodelled Traefik matcher ${token.text}() in rule: ${rule}`);
      }
      take("(");
      const arg = take();
      if (arg.type !== "string") throw new Error(`expected a \`string\` argument in: ${rule}`);
      take(")");
      return { kind: "matcher", name: token.text, value: arg.text };
    }
    throw new Error(`unexpected "${token.text}" in Traefik rule: ${rule}`);
  };
  const ast = parseOr();
  if (pos !== tokens.length) throw new Error(`trailing tokens in Traefik rule: ${rule}`);
  return ast;
}

function ruleMatches(node: RuleNode, req: ProbeRequest): boolean {
  switch (node.kind) {
    case "and":
      return ruleMatches(node.left, req) && ruleMatches(node.right, req);
    case "or":
      return ruleMatches(node.left, req) || ruleMatches(node.right, req);
    case "not":
      return !ruleMatches(node.operand, req);
    case "matcher":
      switch (node.name) {
        case "Host":
          return req.host.toLowerCase() === node.value.toLowerCase();
        case "Method":
          return req.method === node.value.toUpperCase();
        case "Path":
          return req.path === node.value;
        case "PathPrefix":
          return req.path.startsWith(node.value);
      }
  }
}

/** Path/PathPrefix matchers that select requests (i.e. not under a `!`). */
function positivePathMatchers(node: RuleNode, negated = false): MatcherNode[] {
  switch (node.kind) {
    case "and":
    case "or":
      return [
        ...positivePathMatchers(node.left, negated),
        ...positivePathMatchers(node.right, negated),
      ];
    case "not":
      return positivePathMatchers(node.operand, !negated);
    case "matcher":
      return !negated && (node.name === "Path" || node.name === "PathPrefix") ? [node] : [];
  }
}

function hostsOf(node: RuleNode): string[] {
  switch (node.kind) {
    case "and":
    case "or":
      return [...hostsOf(node.left), ...hostsOf(node.right)];
    case "not":
      return hostsOf(node.operand);
    case "matcher":
      return node.name === "Host" ? [node.value] : [];
  }
}

interface TraefikLabel {
  container: string;
  key: string;
  value: string;
}

/** `- "traefik.<key>=<value>"` label lines, tagged with their compose service. */
function parseTraefikLabels(source: string): TraefikLabel[] {
  const labels: TraefikLabel[] = [];
  let section: string | undefined;
  let container: string | undefined;
  for (const line of source.split(/\r?\n/)) {
    const top = line.match(/^([A-Za-z0-9_-]+):/);
    if (top) {
      section = top[1];
      container = undefined;
      continue;
    }
    const service = line.match(/^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/);
    if (service && section === "services") {
      container = service[1];
      continue;
    }
    const label = line.match(/^\s*-\s*"traefik\.([^=]+)=(.*)"\s*$/);
    if (label && container) labels.push({ container, key: label[1], value: label[2] });
  }
  return labels;
}

interface TraefikRouter {
  name: string;
  container: string;
  ruleText: string;
  rule: RuleNode;
  priority?: number;
  service?: string;
  entrypoints?: string;
  middlewares: string[];
}

interface TraefikMiddleware {
  container: string;
  /** option path (lowercased, e.g. "headers.framedeny") → value */
  options: Map<string, string>;
}

interface TraefikModel {
  routers: Map<string, TraefikRouter>;
  middlewares: Map<string, TraefikMiddleware>;
  /** service name → compose container that defines it */
  services: Map<string, string>;
}

function parseTraefik(): TraefikModel {
  const labels = parseTraefikLabels(readInfraFile("docker-compose.traefik.yml"));
  expect(labels.length, "traefik.* labels in docker-compose.traefik.yml").toBeGreaterThan(0);

  const partial = new Map<string, Partial<TraefikRouter> & { container: string }>();
  const middlewares = new Map<string, TraefikMiddleware>();
  const services = new Map<string, string>();

  for (const { container, key, value } of labels) {
    const router = key.match(/^http\.routers\.([^.]+)\.(.+)$/);
    if (router) {
      const [, name, prop] = router;
      const entry = partial.get(name) ?? { name, container, middlewares: [] };
      if (prop === "rule") entry.ruleText = value;
      else if (prop === "priority") entry.priority = Number(value);
      else if (prop === "service") entry.service = value;
      else if (prop === "entrypoints") entry.entrypoints = value;
      else if (prop === "middlewares") entry.middlewares = value.split(",").map((m) => m.trim());
      partial.set(name, entry);
      continue;
    }
    const middleware = key.match(/^http\.middlewares\.([^.]+)\.(.+)$/);
    if (middleware) {
      const [, name, option] = middleware;
      const entry = middlewares.get(name) ?? { container, options: new Map<string, string>() };
      expect(entry.container, `middleware ${name} defined on one container`).toBe(container);
      entry.options.set(option.toLowerCase(), value);
      middlewares.set(name, entry);
      continue;
    }
    const service = key.match(/^http\.services\.([^.]+)\./);
    if (service) services.set(service[1], container);
  }

  const routers = new Map<string, TraefikRouter>();
  for (const [name, entry] of partial) {
    expect(entry.ruleText, `rule of router ${name}`).toBeDefined();
    routers.set(name, {
      name,
      container: entry.container,
      ruleText: entry.ruleText!,
      rule: parseTraefikRule(entry.ruleText!),
      priority: entry.priority,
      service: entry.service,
      entrypoints: entry.entrypoints,
      middlewares: entry.middlewares ?? [],
    });
  }
  return { routers, middlewares, services };
}

/** Traefik v3: an unset priority defaults to the rule's length. */
function effectivePriority(router: TraefikRouter): number {
  return router.priority ?? router.ruleText.length;
}

/** The router Traefik picks: the highest-priority router whose rule matches. */
function traefikRouterFor(model: TraefikModel, req: ProbeRequest): TraefikRouter | undefined {
  return [...model.routers.values()]
    .filter((router) => ruleMatches(router.rule, req))
    .sort((a, b) => effectivePriority(b) - effectivePriority(a))[0];
}

function traefikBackend(model: TraefikModel, req: ProbeRequest): Backend | undefined {
  const router = traefikRouterFor(model, req);
  if (!router) return undefined;
  // Docker provider: a router without `service` uses its own container's.
  const container = router.service ? model.services.get(router.service) : router.container;
  return container === "cms" || container === "web" ? container : undefined;
}

/** Response headers a Traefik `headers` middleware sets (lowercased names). */
function traefikResponseHeaders(options: Map<string, string>): Map<string, string> {
  const headers = new Map<string, string>();
  const sts = { seconds: "", subdomains: false, preload: false };
  for (const [option, value] of options) {
    if (!option.startsWith("headers.")) {
      throw new Error(`not a headers-middleware option: ${option}`);
    }
    const name = option.slice("headers.".length);
    if (name.startsWith("customresponseheaders.")) {
      headers.set(name.slice("customresponseheaders.".length), value);
    } else if (name === "referrerpolicy") headers.set("referrer-policy", value);
    else if (name === "framedeny") {
      if (value === "true") headers.set("x-frame-options", "DENY");
    } else if (name === "contenttypenosniff") {
      if (value === "true") headers.set("x-content-type-options", "nosniff");
    } else if (name === "permissionspolicy") headers.set("permissions-policy", value);
    else if (name === "contentsecuritypolicy") headers.set("content-security-policy", value);
    else if (name === "stsseconds") sts.seconds = value;
    else if (name === "stsincludesubdomains") sts.subdomains = value === "true";
    else if (name === "stspreload") sts.preload = value === "true";
    else throw new Error(`unmodelled Traefik headers option: ${option}`);
  }
  if (sts.seconds) {
    headers.set(
      "strict-transport-security",
      `max-age=${sts.seconds}${sts.subdomains ? "; includeSubDomains" : ""}${sts.preload ? "; preload" : ""}`,
    );
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Caddy model
// ---------------------------------------------------------------------------

interface CaddyRoute {
  /** named matcher, e.g. "nextauth"; undefined = catch-all */
  matcher?: string;
  upstream: string;
  /** source line (0-based) — the file order Caddy's sortRoutes preserves */
  line: number;
}

interface CaddyModel {
  /** named `path` matcher → patterns as written */
  matchers: Map<string, string[]>;
  routes: CaddyRoute[];
  headerSets: Map<string, string>;
  headerRemovals: string[];
}

/**
 * Parses the flat Caddyfile used here. Only the directives below are
 * modelled; anything else (handle, route, redir, a non-path matcher, …)
 * throws, so a structural change forces a conscious model update.
 */
function parseCaddy(): CaddyModel {
  const lines = readInfraFile("Caddyfile").split(/\r?\n/);
  const matchers = new Map<string, string[]>();
  const routes: CaddyRoute[] = [];
  const headerSets = new Map<string, string>();
  const headerRemovals: string[] = [];
  let inHeaderBlock = false;

  lines.forEach((raw, line) => {
    const text = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!text) return;
    if (inHeaderBlock) {
      if (text === "}") {
        inHeaderBlock = false;
        return;
      }
      const removal = text.match(/^-(\S+)$/);
      if (removal) {
        headerRemovals.push(removal[1].toLowerCase());
        return;
      }
      const set = text.match(/^([A-Za-z0-9-]+)\s+(?:"([^"]*)"|(\S+))$/);
      if (!set) throw new Error(`unmodelled Caddyfile header operation: ${text}`);
      headerSets.set(set[1].toLowerCase(), set[2] ?? set[3]);
      return;
    }
    if (/^\{\$DOMAIN(:[^}]*)?\}\s*\{$/.test(text) || text === "}") return;
    if (/^encode\s/.test(text)) return;
    if (text === "header {") {
      inHeaderBlock = true;
      return;
    }
    const matcher = text.match(/^@(\S+)\s+(\S+)\s+(.+)$/);
    if (matcher) {
      if (matcher[2] !== "path") {
        throw new Error(`unmodelled Caddy matcher type "${matcher[2]}" on @${matcher[1]}`);
      }
      matchers.set(matcher[1], matcher[3].trim().split(/\s+/));
      return;
    }
    const proxy = text.match(/^reverse_proxy\s+(?:@(\S+)\s+)?(\S+)$/);
    if (proxy) {
      routes.push({ matcher: proxy[1], upstream: proxy[2], line });
      return;
    }
    throw new Error(`unmodelled Caddyfile directive: ${text}`);
  });
  expect(routes.length, "reverse_proxy routes in Caddyfile").toBeGreaterThan(0);
  return { matchers, routes, headerSets, headerRemovals };
}

/**
 * Caddy's route order for several directives of the SAME name
 * (httpcaddyfile sortRoutes): only when BOTH routes have a single path
 * pattern are they ordered by specificity (longest first). Otherwise a
 * route with a matcher sorts before one without, and routes that both have
 * matchers keep their FILE order (stable sort). @strapi has many patterns,
 * so @nextauth wins only because it is written first.
 */
function caddySortedRoutes(model: CaddyModel): CaddyRoute[] {
  const singlePath = (route: CaddyRoute): string | undefined => {
    const patterns = route.matcher ? model.matchers.get(route.matcher) : undefined;
    return patterns?.length === 1 ? patterns[0] : undefined;
  };
  const less = (a: CaddyRoute, b: CaddyRoute): boolean => {
    const aPath = singlePath(a);
    const bPath = singlePath(b);
    if (aPath && bPath) {
      if (aPath.replace(/\*$/, "") === bPath.replace(/\*$/, "")) return aPath.length < bPath.length;
      return aPath.length > bPath.length;
    }
    return a.matcher !== undefined && b.matcher === undefined;
  };
  return [...model.routes]
    .sort((a, b) => a.line - b.line)
    .sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0));
}

/** Go's URL.Path is the percent-decoded path; Caddy matches on that. */
function decodedPath(rawPath: string): string {
  return decodeURIComponent(rawPath);
}

/** Caddy MatchPath: lowercase + CleanPath (path.Clean, trailing slash kept). */
function caddyPathMatches(patterns: string[], rawPath: string): boolean {
  // posix.normalize == Go path.Clean for absolute paths, except that it
  // already keeps a trailing slash — exactly Caddy's cleanPath.
  const cleaned = posix.normalize(decodedPath(rawPath).toLowerCase());
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    if (pattern.includes("%") || pattern.includes("//") || pattern.startsWith("*")) {
      throw new Error(`unmodelled Caddy path pattern: ${raw}`);
    }
    if (pattern.endsWith("*")) return cleaned.startsWith(pattern.slice(0, -1));
    if (/[*?[\]]/.test(pattern)) throw new Error(`unmodelled Caddy glob: ${raw}`);
    return cleaned === pattern;
  });
}

function caddyRouteFor(model: CaddyModel, rawPath: string): CaddyRoute | undefined {
  return caddySortedRoutes(model).find(
    (route) => !route.matcher || caddyPathMatches(model.matchers.get(route.matcher)!, rawPath),
  );
}

function caddyBackend(model: CaddyModel, rawPath: string): Backend | undefined {
  const upstream = caddyRouteFor(model, rawPath)?.upstream;
  if (upstream === "web:3000") return "web";
  if (upstream === "cms:1337") return "cms";
  return undefined;
}

/** "/api/*" → "api", "/admin*" → "admin", "/upload" → "upload". */
function firstSegment(pattern: string): string {
  return pattern.replace(/^\//, "").split("/")[0].replace(/\*$/, "");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Traefik/Caddy routing parity (issue #22)", () => {
  const traefik = parseTraefik();
  const caddy = parseCaddy();

  const cmsRouter = traefik.routers.get("sinnlos-cms");
  const traefikCmsPaths = cmsRouter ? positivePathMatchers(cmsRouter.rule).map((m) => m.value) : [];
  const caddyStrapiPatterns = caddy.matchers.get("strapi") ?? [];
  const hosts = [...new Set([...traefik.routers.values()].flatMap((r) => hostsOf(r.rule)))];
  const host = hosts[0] ?? "";
  const request = (method: Method, path: string): ProbeRequest => ({ host, method, path });

  it("Traefik cms router covers exactly the canonical prefixes", () => {
    expect(traefikCmsPaths.length, "path matchers in the sinnlos-cms rule").toBeGreaterThan(0);
    expect([...new Set(traefikCmsPaths.map(firstSegment))].sort()).toEqual(CMS_PREFIXES);
  });

  it("Caddy @strapi matcher covers exactly the canonical prefixes", () => {
    expect(caddyStrapiPatterns.length, "path patterns on @strapi").toBeGreaterThan(0);
    expect([...new Set(caddyStrapiPatterns.map(firstSegment))].sort()).toEqual(CMS_PREFIXES);
  });

  it("neither proxy routes /uploads (file bytes) to cms — issue #21", () => {
    expect(traefikCmsPaths.map(firstSegment)).not.toContain("uploads");
    expect(caddyStrapiPatterns.map(firstSegment)).not.toContain("uploads");
  });

  it.each(PROBES)("routes %s %s to %s under BOTH proxies", (method, path, backend) => {
    expect(traefikBackend(traefik, request(method, path)), `Traefik: ${method} ${path}`).toBe(
      backend,
    );
    expect(caddyBackend(caddy, path), `Caddy: ${method} ${path}`).toBe(backend);
  });

  describe("Traefik routers and priorities", () => {
    it("defines exactly the known routers with their load-bearing priorities", () => {
      const priorities = Object.fromEntries(
        [...traefik.routers.values()].map((router) => [router.name, router.priority]),
      );
      expect(priorities).toEqual(TRAEFIK_ROUTER_PRIORITIES);
    });

    it("orders auth > signin > cms > catch-all", () => {
      const p = (name: string) => traefik.routers.get(name)?.priority ?? -1;
      expect(p("sinnlos-auth")).toBeGreaterThan(p("sinnlos-signin"));
      expect(p("sinnlos-signin")).toBeGreaterThan(p("sinnlos-cms"));
      expect(p("sinnlos-cms")).toBeGreaterThan(p("sinnlos-web"));
    });

    it("serves one host on the websecure entrypoint from every router", () => {
      expect(hosts).toHaveLength(1);
      for (const router of traefik.routers.values()) {
        expect(hostsOf(router.rule), `Host() in ${router.name}`).toEqual(hosts);
        expect(router.entrypoints, `entrypoints of ${router.name}`).toBe("websecure");
      }
    });

    it.each(TRAEFIK_ROUTER_PROBES)("%s %s is handled by %s", (method, path, name) => {
      expect(traefikRouterFor(traefik, request(method, path))?.name).toBe(name);
    });

    it("rate-limits the sign-in POSTs tighter than the auth and cms routers", () => {
      expect(traefik.routers.get("sinnlos-signin")?.middlewares).toContain("sinnlos-authlimit");
      expect(traefik.routers.get("sinnlos-auth")?.middlewares).toContain("sinnlos-ratelimit");
      expect(traefik.routers.get("sinnlos-cms")?.middlewares).toContain("sinnlos-ratelimit");
    });

    it("references only middlewares that are defined", () => {
      for (const router of traefik.routers.values()) {
        for (const name of router.middlewares) {
          expect(traefik.middlewares.has(name), `${router.name} → middleware ${name}`).toBe(true);
        }
      }
    });

    it("currently defines the cms router's middlewares on the web container (FX34)", () => {
      // Known coupling: while web is starting or stopped, Traefik drops web's
      // labels — and with them the middlewares the cms router needs, so
      // /api and /admin go down too. FX34 moves the definitions off web;
      // that change must flip this assertion.
      const containers = new Set(
        (cmsRouter?.middlewares ?? []).map((name) => traefik.middlewares.get(name)?.container),
      );
      expect([...containers]).toEqual(["web"]);
    });
  });

  describe("Caddy route order", () => {
    it("declares @nextauth before @strapi in the file", () => {
      const line = (matcher: string) =>
        caddy.routes.find((route) => route.matcher === matcher)?.line ?? -1;
      expect(line("nextauth")).toBeGreaterThanOrEqual(0);
      expect(line("strapi")).toBeGreaterThan(line("nextauth"));
    });

    it("resolves to @nextauth → @strapi → catch-all under Caddy's sortRoutes", () => {
      expect(caddySortedRoutes(caddy).map((route) => route.matcher ?? "*")).toEqual([
        "nextauth",
        "strapi",
        "*",
      ]);
      expect(caddy.matchers.get("nextauth")).toEqual(["/api/auth/*"]);
    });

    it("ends in exactly one catch-all to web", () => {
      const catchAll = caddy.routes.filter((route) => !route.matcher);
      expect(catchAll).toHaveLength(1);
      expect(catchAll[0].upstream).toBe("web:3000");
    });
  });

  describe("case semantics (Traefik case-sensitive, Caddy lowercases)", () => {
    it.each(CASE_PROBES)("%s → Traefik %s, Caddy %s", (path, viaTraefik, viaCaddy) => {
      expect(traefikBackend(traefik, request("POST", path)), `Traefik: ${path}`).toBe(viaTraefik);
      expect(caddyBackend(caddy, path), `Caddy: ${path}`).toBe(viaCaddy);
    });

    it("D-EDGE-01: Traefik hands /api/Auth/local to the cms router", () => {
      expect(traefikRouterFor(traefik, request("POST", "/api/Auth/local"))?.name).toBe(
        "sinnlos-cms",
      );
    });
  });

  // Invariant: Traefik's raw-path routing lets `..` traversal reach cms, so
  // the /uploads protection MUST be cms-side (the token gate, fix K1) — the
  // edge routing alone is NOT sufficient. See TRAVERSAL above.
  it.each(TRAVERSAL)(
    "Traefik delivers traversal %s to cms, Caddy cleans it to web — protection must be cms-side (K1)",
    (path) => {
      expect(traefikBackend(traefik, request("GET", path)), `Traefik routes ${path}`).toBe("cms");
      expect(caddyBackend(caddy, path), `Caddy routes ${path}`).toBe("web");
    },
  );

  it.each(KNOWN_DIFFERENCES)(
    "known difference: %s → Traefik %s, Caddy %s",
    (path, viaTraefik, viaCaddy) => {
      expect(traefikBackend(traefik, request("GET", path)), `Traefik: ${path}`).toBe(viaTraefik);
      expect(caddyBackend(caddy, path), `Caddy: ${path}`).toBe(viaCaddy);
    },
  );

  describe("security-header parity", () => {
    const headerMiddlewares = [...traefik.middlewares].filter(([, middleware]) =>
      [...middleware.options.keys()].some((option) => option.startsWith("headers.")),
    );
    const [headersName, headersMiddleware] = headerMiddlewares[0] ?? ["", undefined];
    const traefikHeaders = headersMiddleware
      ? traefikResponseHeaders(headersMiddleware.options)
      : new Map<string, string>();

    it("has exactly one Traefik headers middleware, applied on every router", () => {
      expect(headerMiddlewares).toHaveLength(1);
      for (const router of traefik.routers.values()) {
        expect(router.middlewares, `middlewares of ${router.name}`).toContain(headersName);
      }
    });

    it("sets every shared header to the same value in both proxies", () => {
      const shared = [...caddy.headerSets.keys()].filter((name) => traefikHeaders.has(name));
      expect(shared.length).toBeGreaterThan(0);
      for (const name of shared) {
        expect(caddy.headerSets.get(name), `Caddy ${name}`).toBe(traefikHeaders.get(name));
      }
    });

    it("lacks in Caddy exactly the known FX33 gaps", () => {
      const missing = [...traefikHeaders.keys()].filter((name) => !caddy.headerSets.has(name));
      expect(missing.sort()).toEqual(KNOWN_CADDY_HEADER_GAPS);
    });

    it("sets no header in Caddy that Traefik lacks", () => {
      expect([...caddy.headerSets.keys()].filter((name) => !traefikHeaders.has(name))).toEqual([]);
    });

    it("only strips Caddy's own Server header", () => {
      expect(caddy.headerRemovals).toEqual(["server"]);
    });
  });
});
