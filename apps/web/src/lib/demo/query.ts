/**
 * Strapi's REST query semantics for the DEMO_MODE fixtures, as far as the
 * web uses them: `filters` ($eq/$ne/$lt/$lte/$gt/$gte/$null/$notNull/$in/
 * $containsi, nested $or/$and, relation paths), `sort` and pagination.
 */
import { StrapiError } from "@/lib/strapi-error";

/** A dev-only hint: the demo has no answer for something the web asked. */
export function warn(message: string): void {
  if (process.env.NODE_ENV !== "production") console.warn(`[demo] ${message}`);
}

/** What the cms answers for a refused request (ctx.badRequest, ctx.forbidden, ctx.notFound). */
export function cmsError(
  status: 400 | 403 | 404,
  message: string,
  details: object = {},
): StrapiError {
  const [statusText, name] = {
    400: ["Bad Request", "BadRequestError"],
    403: ["Forbidden", "ForbiddenError"],
    404: ["Not Found", "NotFoundError"],
  }[status];
  return new StrapiError(
    status,
    statusText,
    JSON.stringify({ data: null, error: { status, name, message, details } }),
  );
}

/** A parsed `filters` tree: operators and attributes, leaves are the raw values. */
type FilterTree = { [key: string]: FilterTree | string };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A property of a row (or of a populated relation). */
const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined);

/** `filters[a][$or][0][b][$eq]=v` → { a: { $or: { 0: { b: { $eq: "v" } } } } }. */
function filterTree(params: URLSearchParams): FilterTree {
  const tree: FilterTree = {};
  for (const [key, value] of params) {
    if (!key.startsWith("filters[")) continue;
    const segments = [...key.slice("filters".length).matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]!);
    let node = tree;
    segments.forEach((segment, i) => {
      if (i === segments.length - 1) {
        node[segment] = value;
        return;
      }
      const next = node[segment];
      if (typeof next === "object") {
        node = next;
      } else {
        const created: FilterTree = {};
        node[segment] = created;
        node = created;
      }
    });
  }
  return tree;
}

/** Order of a row value and a filter value: numbers numerically, else as text (ISO instants and dates sort as text). */
function order(value: string | number | boolean, operand: string): number {
  if (typeof value === "number") return value - Number(operand);
  const text = String(value);
  return text < operand ? -1 : text > operand ? 1 : 0;
}

/**
 * One operator on one value. Like SQL, a comparison with a missing value
 * (NULL) is false: `blocked $ne true` does not take a user without the
 * column, which is why the web adds `$null` next to it.
 */
function applies(operator: string, value: unknown, operand: FilterTree | string): boolean {
  if (operator === "$in") {
    return (
      typeof operand === "object" &&
      value != null &&
      Object.values(operand).some((item) => typeof item === "string" && String(value) === item)
    );
  }
  if (typeof operand !== "string") return false;
  if (operator === "$null") return (value == null) === (operand === "true");
  if (operator === "$notNull") return (value != null) === (operand === "true");
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    return false;
  }
  switch (operator) {
    case "$eq":
      return String(value) === operand;
    case "$ne":
      return String(value) !== operand;
    case "$lt":
      return order(value, operand) < 0;
    case "$lte":
      return order(value, operand) <= 0;
    case "$gt":
      return order(value, operand) > 0;
    case "$gte":
      return order(value, operand) >= 0;
    case "$containsi":
      return String(value).toLowerCase().includes(operand.toLowerCase());
    default:
      warn(`unsupported filter operator ${operator}`);
      return false;
  }
}

/** Whether `value` (a row, a relation, a list of relations or a scalar) passes `tree`. */
function passes(value: unknown, tree: FilterTree): boolean {
  // A to-many relation passes when one of its rows does (a join).
  if (Array.isArray(value)) return value.some((item) => passes(item, tree));
  return Object.entries(tree).every(([key, child]) => {
    if (key === "$or" || key === "$and") {
      const branches = typeof child === "object" ? Object.values(child) : [];
      const test = (branch: FilterTree | string) =>
        typeof branch === "object" && passes(value, branch);
      return key === "$or" ? branches.some(test) : branches.every(test);
    }
    if (key.startsWith("$")) return applies(key, value, child);
    return typeof child === "object" && passes(field(value, key), child);
  });
}

/** `sort=a:desc,b` or `sort[0]=a:desc&sort[1]=b` → [["a", -1], ["b", 1]]. */
function sortSpecs(params: URLSearchParams): [string, number][] {
  const specs = [
    ...params.getAll("sort").flatMap((value) => value.split(",")),
    ...[...params]
      .filter(([key]) => /^sort\[\d+\]$/.test(key))
      .sort(([a], [b]) => Number(a.slice(5, -1)) - Number(b.slice(5, -1)))
      .map(([, value]) => value),
  ];
  return specs
    .filter((spec) => spec !== "")
    .map((spec) => {
      const [name = "", direction = "asc"] = spec.split(":");
      return [name, direction.toLowerCase() === "desc" ? -1 : 1];
    });
}

function compareValues(a: unknown, b: unknown): number {
  if (a == null || b == null) return a == null ? (b == null ? 0 : 1) : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  const [x, y] = [String(a), String(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The rows that pass the request's filters, in the request's sort order. */
export function query<T>(rows: readonly T[], params: URLSearchParams): T[] {
  const tree = filterTree(params);
  const specs = sortSpecs(params);
  const matched = rows.filter((row) => passes(row, tree));
  return specs.length === 0
    ? matched
    : [...matched].sort((a, b) => {
        for (const [name, direction] of specs) {
          const diff = compareValues(field(a, name), field(b, name));
          if (diff !== 0) return diff * direction;
        }
        return 0;
      });
}

/** A content-type `find` answer: filtered, sorted, one page with its pagination. */
export function list<T>(rows: readonly T[], params: URLSearchParams) {
  const matched = query(rows, params);
  const pageSize = Math.max(1, Number(params.get("pagination[pageSize]") ?? 25) || 25);
  const page = Math.max(1, Number(params.get("pagination[page]") ?? 1) || 1);
  return {
    data: matched.slice((page - 1) * pageSize, page * pageSize),
    meta: {
      pagination: {
        page,
        pageSize,
        pageCount: Math.ceil(matched.length / pageSize),
        total: matched.length,
      },
    },
  };
}
