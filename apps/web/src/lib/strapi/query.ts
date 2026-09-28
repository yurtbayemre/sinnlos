/**
 * Strapi REST query strings (WD01), built parameter by parameter in the
 * order of the calls: the order is part of the URL, and every read's exact
 * bytes are pinned by lib/strapi-urls.test.ts.
 *
 * A query has two kinds of parts, and the builder keeps them apart:
 *   - STRUCTURE: keys (`filters[slug][$eq]`, `populate[head][fields][0]`),
 *     field and relation names, sort specs (`name:asc`), the `true` of a
 *     populate. They are code constants and go out as written: Strapi's qs
 *     parser reads brackets, `$`, `:` and `,` literally. Each one must match
 *     STRUCTURE_RE (letters, digits and `_ $ . : , - [ ]`) or the builder
 *     throws, so a structure part can never carry `&`, `=`, `#`, `%`, `?`
 *     or a space into the URL.
 *   - VALUES: everything that comes from a caller or a user (slugs, ids,
 *     documentIds, ISO instants, dates, search terms, categories) is
 *     percent-encoded with encodeURIComponent, always.
 * Strapi decodes this subset of the qs syntax, so no dependency (qs) is
 * needed on the web side.
 */

/** A structure part as it may appear in a URL unencoded. */
const STRUCTURE_RE = /^[A-Za-z0-9_$.:,\-[\]]+$/;

/** A filter or parameter value; always percent-encoded. */
export type QueryValue = string | number | boolean;

/** A path below `filters`: attribute names, `$or`/`$and` and their indexes. */
export type FilterPath = string | readonly (string | number)[];

/** The Strapi filter operators this web sends. */
export type FilterOperator =
  | "$eq"
  | "$ne"
  | "$lt"
  | "$lte"
  | "$gt"
  | "$gte"
  | "$null"
  | "$notNull"
  | "$containsi";

/** Throws unless `part` is safe to write unencoded (see STRUCTURE_RE). */
function structure(part: string): string {
  if (!STRUCTURE_RE.test(part)) {
    throw new Error(`[strapi-query] not a structure part: ${JSON.stringify(part)}`);
  }
  return part;
}

/** `[a][b][0]` for a path, each segment checked as structure. */
function brackets(path: FilterPath | readonly string[]): string {
  const segments = typeof path === "string" ? [path] : path;
  return segments.map((segment) => `[${structure(String(segment))}]`).join("");
}

/** A relation path below `populate`: `a` or `a.populate.b` as `[a][populate][b]`. */
function populatePath(relation: string | readonly string[]): string {
  const segments = typeof relation === "string" ? [relation] : relation;
  return `populate${segments.map((segment) => `[${structure(segment)}]`).join("[populate]")}`;
}

export class StrapiQuery {
  readonly #parts: string[] = [];

  /** `key=value`, the value percent-encoded (caller data). */
  value(key: string, value: QueryValue): this {
    this.#parts.push(`${structure(key)}=${encodeURIComponent(String(value))}`);
    return this;
  }

  /** `key=v1,v2,…`: each value percent-encoded, joined by a literal comma. */
  list(key: string, values: readonly QueryValue[]): this {
    this.#parts.push(
      `${structure(key)}=${values.map((value) => encodeURIComponent(String(value))).join(",")}`,
    );
    return this;
  }

  /** `key=literal`, written as it is: code constants only (checked). */
  literal(key: string, literal: QueryValue): this {
    this.#parts.push(`${structure(key)}=${structure(String(literal))}`);
    return this;
  }

  /** `filters[<path>][<operator>]=<value>`, the value percent-encoded. */
  filter(path: FilterPath, operator: FilterOperator, value: QueryValue): this {
    return this.value(`filters${brackets(path)}[${operator}]`, value);
  }

  /** `filters[<path>][$in][i]=<value>` per value, each percent-encoded. */
  filterIn(path: FilterPath, values: readonly QueryValue[]): this {
    values.forEach((value, i) => this.value(`filters${brackets(path)}[$in][${i}]`, value));
    return this;
  }

  /** `fields[i]=<name>`. */
  fields(names: readonly string[]): this {
    names.forEach((name, i) => this.literal(`fields[${i}]`, name));
    return this;
  }

  /** `populate[<relation>]=true`; a path populates below a populate. */
  populate(relation: string | readonly string[]): this {
    return this.literal(populatePath(relation), true);
  }

  /** `populate[<relation>][fields][i]=<name>`: a field-limited populate. */
  populateFields(relation: string | readonly string[], names: readonly string[]): this {
    names.forEach((name, i) => this.literal(`${populatePath(relation)}[fields][${i}]`, name));
    return this;
  }

  /** `sort[i]=<spec>` (`name:asc`, …). */
  sort(specs: readonly string[]): this {
    specs.forEach((spec, i) => this.literal(`sort[${i}]`, spec));
    return this;
  }

  /** `sort=<spec>`: Strapi's single-parameter form (`a:desc,b:desc`). */
  sortBy(spec: string): this {
    return this.literal("sort", spec);
  }

  /** `pagination[page]=<page>&pagination[pageSize]=<size>`. */
  page(page: number, pageSize: number): this {
    return this.value("pagination[page]", page).value("pagination[pageSize]", pageSize);
  }

  /** `pagination[pageSize]=<size>` (the first page). */
  pageSize(pageSize: number): this {
    return this.value("pagination[pageSize]", pageSize);
  }

  /** Appends the parts of another query, in order. */
  append(other: StrapiQuery): this {
    this.#parts.push(...other.#parts);
    return this;
  }

  /** The query string without the leading `?`. */
  toString(): string {
    return this.#parts.join("&");
  }
}

/** A new, empty query. */
export function strapiQuery(): StrapiQuery {
  return new StrapiQuery();
}

/** `path?query` (no `?` for an empty query). */
export function withQuery(path: string, query: StrapiQuery): string {
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}
