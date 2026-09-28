/**
 * Shared, typed Strapi stub for cms unit tests (roadmap S03).
 *
 * Named *.test.helper.ts so the Strapi build skips it (apps/cms/tsconfig.json
 * excludes **\/*.test.*) and Vitest does not collect it as a suite; living
 * under src/ keeps it inside tsconfig.test.cms.json. Its own behaviour is
 * pinned by strapi-stub.test.ts, which runs the same where clauses, selects
 * and populates against @strapi/database 5.55.1 on SQLite and requires the
 * same result.
 *
 * What it models:
 *   - `db.query(uid)`: findOne, findMany, count, create, update, updateMany,
 *     delete and deleteMany over in-memory rows, with a `where` evaluator for
 *     $and, $or, $not, $eq, $ne, $in, $notIn, $null, $notNull, $lt, $lte,
 *     $gt and $gte, relation traversal (to-one and to-many, "any related row
 *     matches"), `select`, `populate` (relations are only returned when
 *     populated, like the real query engine), `orderBy`, `limit`, `offset`.
 *     An operator it does not know throws, so a test cannot pass by accident,
 *     and so does `$not` over a relation (SQL applies NOT per joined row,
 *     which an in-memory "not any" gets wrong). SQL semantics where they
 *     differ from JavaScript: `$ne`, `$lt` and friends never match NULL,
 *     `$eq: null` / `$ne: null` mean IS (NOT) NULL, `$in: []` matches
 *     nothing, `$notIn: []` everything, an array value means "any of", ids
 *     are never reused (AUTOINCREMENT / serial), and NULLs sort first
 *     ascending (SQLite; Postgres sorts them last).
 *   - `documents(uid)`: a document service over the SAME rows. Draft &
 *     publish types (read from the real schema.json files) keep a draft row
 *     and a published row per document with DIFFERENT ids, and publish is
 *     delete + recreate, so the published id changes on every publish.
 *     department and team are single-row (decision 05): one row, publishedAt
 *     set, and `status` is ignored. The default status is "draft", as in the
 *     real Document Service (the REST core service defaults to "published").
 *     `update` of a document without a draft row writes a draft from the
 *     payload only, like Strapi 5.55.1 (the FX38 root cause, pinned in
 *     framework-contract.test.ts).
 *   - `plugin(name).service(name)` and `service(uid)` from a map the test
 *     passes; an unstubbed service throws.
 *   - `log.{debug,info,warn,error}` as vi.fn() spies.
 *   - `db.transaction(cb)` with `onCommit` / `onRollback`: nested calls join
 *     the outer transaction and the callbacks run when the OUTERMOST one
 *     settles, like @strapi/database's transaction context. Rows are not
 *     rolled back (a stub, not a database).
 *   - `calls`: every db.query and documents() call, in order, so a test can
 *     assert that a code path touched no data at all.
 *
 * Rows hold their relations as objects (`department: { id: 10 }`) or arrays
 * of objects (`teams: [{ id: 30 }]`). When the relation's target table holds
 * a row with that id, the stored row IS the related row (populate returns its
 * columns, a nested where tests them, like a join); otherwise the embedded
 * object is used as written. Which keys are relations comes from the content
 * type's schema (the real schema.json files, plus `schemas` a test passes for
 * its own models); for an unknown uid it goes by shape (an object or a
 * non-empty array of objects with a numeric id). A relation written as a bare
 * id (`data: { recipient: 7 }`) is stored as `{ id: 7 }`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vi, type Mock } from "vitest";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One stored row. Relations are embedded objects or arrays of objects. */
export interface Row {
  id: number;
  [key: string]: unknown;
}

export type Tables = Record<string, Row[]>;

/** A Strapi db-layer where clause. */
export type Where = Record<string, unknown>;

type Direction = "asc" | "desc";

export type OrderBy =
  | string
  | Record<string, Direction>
  | ReadonlyArray<string | Record<string, Direction>>;

/** Nested populate options, as the query engine takes them. */
export interface PopulateOptions {
  select?: string | readonly string[];
  populate?: Populate;
  where?: Where;
  orderBy?: OrderBy;
}

export type Populate = true | "*" | readonly string[] | Record<string, boolean | PopulateOptions>;

export interface QueryParams {
  where?: Where;
  select?: string | readonly string[];
  populate?: Populate;
  orderBy?: OrderBy;
  limit?: number;
  offset?: number;
  data?: Record<string, unknown>;
}

export interface StubQuery {
  findOne(params?: QueryParams): Promise<Row | null>;
  findMany(params?: QueryParams): Promise<Row[]>;
  count(params?: QueryParams): Promise<number>;
  create(params: QueryParams & { data: Record<string, unknown> }): Promise<Row>;
  update(params: QueryParams & { data: Record<string, unknown> }): Promise<Row | null>;
  updateMany(params: QueryParams & { data: Record<string, unknown> }): Promise<{ count: number }>;
  delete(params: QueryParams): Promise<Row | null>;
  deleteMany(params?: QueryParams): Promise<{ count: number }>;
}

export type DocumentStatus = "draft" | "published";

export interface DocumentParams {
  documentId?: string;
  status?: DocumentStatus;
  filters?: Where;
  fields?: readonly string[];
  populate?: Populate;
  sort?: OrderBy;
  data?: Record<string, unknown>;
}

export interface DocumentResult {
  documentId: string;
  entries: Row[];
}

export interface StubDocuments {
  findOne(params: DocumentParams & { documentId: string }): Promise<Row | null>;
  findFirst(params?: DocumentParams): Promise<Row | null>;
  findMany(params?: DocumentParams): Promise<Row[]>;
  count(params?: DocumentParams): Promise<number>;
  create(params: DocumentParams & { data: Record<string, unknown> }): Promise<Row>;
  update(
    params: DocumentParams & { documentId: string; data: Record<string, unknown> },
  ): Promise<Row | null>;
  delete(params: { documentId: string }): Promise<DocumentResult>;
  publish(params: { documentId: string }): Promise<DocumentResult>;
  unpublish(params: { documentId: string }): Promise<DocumentResult>;
  discardDraft(params: { documentId: string }): Promise<DocumentResult>;
}

export interface TransactionScope {
  trx: object;
  onCommit(callback: () => unknown): void;
  onRollback(callback: () => unknown): void;
}

export interface StubCall {
  api: "db" | "documents";
  uid: string;
  method: string;
  params: unknown;
}

type LogFn = (...args: unknown[]) => void;

export interface StubLog {
  debug: Mock<LogFn>;
  info: Mock<LogFn>;
  warn: Mock<LogFn>;
  error: Mock<LogFn>;
}

export type ServiceMap = Record<string, object>;

export interface AttributeSchema {
  type: string;
  relation?: string;
  target?: string;
  mappedBy?: string;
  inversedBy?: string;
  enum?: readonly string[];
  default?: unknown;
}

export interface ContentTypeSchema {
  uid: string;
  kind?: string;
  collectionName?: string;
  info?: { singularName?: string; pluralName?: string };
  options?: { draftAndPublish?: boolean };
  attributes: Record<string, AttributeSchema>;
}

export interface StrapiStubOptions {
  /** Initial rows per uid (copied, so fixtures can be shared between tests). */
  tables?: Tables;
  /** Extra content types (test-only models); a real uid here overrides its schema.json. */
  schemas?: Record<string, ContentTypeSchema>;
  /** Plugin services: `{ "users-permissions": { user: {...} } }`. */
  plugins?: Record<string, ServiceMap>;
  /** API services by uid: `{ "api::poll.poll": {...} }`. */
  services?: ServiceMap;
  /** What `requestContext.get()` returns (undefined = no request in scope). */
  requestContext?: unknown;
  /** Clock for publishedAt/createdAt/updatedAt (default: a fixed instant). */
  now?: () => string;
}

export interface StrapiStub {
  db: {
    query(uid: string): StubQuery;
    transaction<T>(callback: (scope: TransactionScope) => Promise<T> | T): Promise<T>;
    inTransaction(): boolean;
  };
  documents(uid: string): StubDocuments;
  plugin(name: string): { service(name: string): object };
  service(uid: string): object;
  contentType(uid: string): ContentTypeSchema | undefined;
  getModel(uid: string): ContentTypeSchema | undefined;
  requestContext: { get(): unknown };
  log: StubLog;
  /** Every db.query / documents() call, in order. */
  calls: StubCall[];
  /** The live rows (mutated by writes). */
  tables: Tables;
  /** Draft & publish per the content type's schema; an unknown uid throws. */
  hasDraftAndPublish(uid: string): boolean;
  /**
   * Adds one document the way the Document Service stores it: a draft row
   * and, with status "published", a published twin with a different id
   * (draft & publish types); one row with publishedAt set otherwise.
   */
  seedDocument(
    uid: string,
    data: Record<string, unknown>,
    options?: { status?: DocumentStatus; documentId?: string },
  ): { documentId: string; draft: Row | null; published: Row | null };
}

// ---------------------------------------------------------------------------
// Content-type schemas (the real ones)
// ---------------------------------------------------------------------------

const SRC_DIR = join(__dirname, "..");

function readSchema(file: string, uid: string): ContentTypeSchema {
  const raw = JSON.parse(readFileSync(file, "utf8")) as Omit<ContentTypeSchema, "uid">;
  return { ...raw, uid };
}

/**
 * Every content type of this cms, from its schema.json: api::<api>.<type>
 * plus the users-permissions user extension.
 */
export function loadContentTypeSchemas(): Record<string, ContentTypeSchema> {
  const schemas: Record<string, ContentTypeSchema> = {};
  const apiDir = join(SRC_DIR, "api");
  for (const api of readdirSync(apiDir)) {
    const typesDir = join(apiDir, api, "content-types");
    if (!existsSync(typesDir)) continue;
    for (const type of readdirSync(typesDir)) {
      const file = join(typesDir, type, "schema.json");
      if (existsSync(file))
        schemas[`api::${api}.${type}`] = readSchema(file, `api::${api}.${type}`);
    }
  }
  const userFile = join(
    SRC_DIR,
    "extensions",
    "users-permissions",
    "content-types",
    "user",
    "schema.json",
  );
  if (existsSync(userFile)) {
    schemas["plugin::users-permissions.user"] = readSchema(
      userFile,
      "plugin::users-permissions.user",
    );
  }
  return schemas;
}

const CMS_SCHEMAS = loadContentTypeSchemas();

// ---------------------------------------------------------------------------
// Scalars and operators
// ---------------------------------------------------------------------------

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

/** Array.isArray that also narrows readonly arrays. */
const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const hasNumericId = (value: unknown): value is Row =>
  isPlainObject(value) && typeof value.id === "number";

const castArray = (value: unknown): readonly unknown[] => (isList(value) ? value : [value]);

const isNull = (value: unknown) => value === null || value === undefined;

/** The column operators the evaluator knows (plus $and/$or/$not at root level). */
const COLUMN_OPERATORS = new Set([
  "$not",
  "$eq",
  "$ne",
  "$in",
  "$notIn",
  "$null",
  "$notNull",
  "$lt",
  "$lte",
  "$gt",
  "$gte",
]);

const isOperator = (key: string) => key.startsWith("$");

/** Comparable form of a scalar (Dates as epoch ms). */
function comparable(value: unknown): number | string | boolean | null {
  if (isNull(value)) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean")
    return value;
  throw new Error(`strapi-stub: cannot compare ${JSON.stringify(value)}`);
}

function sqlEquals(left: unknown, right: unknown): boolean {
  const a = comparable(left);
  const b = comparable(right);
  if (a === null || b === null) return false;
  // SQLite compares 2 = '2' as equal (route params arrive as strings); the
  // stub allows exactly that and nothing looser.
  if (typeof a === "number" && typeof b === "string") return String(a) === b;
  if (typeof a === "string" && typeof b === "number") return a === String(b);
  return a === b;
}

function sqlCompare(left: unknown, right: unknown, op: "$lt" | "$lte" | "$gt" | "$gte"): boolean {
  const a = comparable(left);
  const b = comparable(right);
  if (a === null || b === null) return false;
  const x = typeof a === "boolean" ? Number(a) : a;
  const y = typeof b === "boolean" ? Number(b) : b;
  if (typeof x !== typeof y)
    throw new Error(`strapi-stub: ${op} between ${typeof x} and ${typeof y}`);
  if (op === "$lt") return x < y;
  if (op === "$lte") return x <= y;
  if (op === "$gt") return x > y;
  return x >= y;
}

/** One operator applied to one column value (SQL semantics). */
function matchOperator(value: unknown, op: string, operand: unknown): boolean {
  if (!COLUMN_OPERATORS.has(op)) throw new Error(`strapi-stub: operator ${op} is not modelled`);
  // An array operand on a non-array operator means "any of" (the engine ORs them).
  if (isList(operand) && op !== "$in" && op !== "$notIn") {
    return operand.some((sub) => matchOperator(value, op, sub));
  }
  switch (op) {
    case "$eq":
      return operand === null ? isNull(value) : sqlEquals(value, operand);
    case "$ne":
      return operand === null ? !isNull(value) : !isNull(value) && !sqlEquals(value, operand);
    case "$in":
      return castArray(operand).some((candidate) => sqlEquals(value, candidate));
    case "$notIn":
      return !isNull(value) && !castArray(operand).some((candidate) => sqlEquals(value, candidate));
    case "$null":
      return operand ? isNull(value) : !isNull(value);
    case "$notNull":
      return operand ? !isNull(value) : isNull(value);
    case "$lt":
    case "$lte":
    case "$gt":
    case "$gte":
      return sqlCompare(value, operand, op);
    default:
      // $not on a column
      return !matchColumn(value, operand);
  }
}

/** A column condition: a scalar / array shorthand or an object of column operators. */
function matchColumn(value: unknown, condition: unknown): boolean {
  if (!isPlainObject(condition)) return matchOperator(value, "$eq", condition);
  return Object.entries(condition).every(([op, operand]) => matchOperator(value, op, operand));
}

/** What a LEFT JOIN yields for a row without related rows: every column NULL. */
const NULL_ROW = { id: null } as unknown as Row;

// ---------------------------------------------------------------------------
// The evaluator: where, projection, ordering (schema-aware)
// ---------------------------------------------------------------------------

export interface Evaluator {
  matchWhere(uid: string | null, row: Row, where: Where | readonly Where[] | undefined): boolean;
  project(
    uid: string | null,
    row: Row,
    select: string | readonly string[] | undefined,
    populate: Populate | undefined,
  ): Row;
  sortRows(rows: Row[], orderBy: OrderBy | undefined): Row[];
  relationKeys(uid: string): Set<string> | null;
}

/** Finds a stored row of a relation's target table (the stub's tables). */
export type RowLookup = (uid: string, id: number) => Row | undefined;

/**
 * `lookup` resolves a relation reference: when the target table holds a row
 * with that id, the stored row is the related row (a reference `{ id: 10 }`
 * then populates with every column, like a join); otherwise the embedded
 * object is used as it is.
 */
export function createEvaluator(
  schemas: Record<string, ContentTypeSchema>,
  lookup?: RowLookup,
): Evaluator {
  /** The related rows of `row[key]`, a bare id counting as `{ id }`. */
  const relatedRows = (targetUid: string | null, value: unknown): Row[] => {
    if (isNull(value)) return [];
    return castArray(value)
      .map((item) => (typeof item === "number" ? { id: item } : item))
      .filter(hasNumericId)
      .map((ref) => (targetUid && lookup ? (lookup(targetUid, ref.id) ?? ref) : ref));
  };

  const relationKeys = (uid: string): Set<string> | null => {
    const schema = schemas[uid];
    if (!schema) return null;
    return new Set(
      Object.entries(schema.attributes)
        .filter(([, attribute]) => attribute.type === "relation" || attribute.type === "media")
        .map(([key]) => key),
    );
  };

  const attributeOf = (uid: string | null, key: string): AttributeSchema | undefined =>
    uid ? schemas[uid]?.attributes[key] : undefined;

  const targetOf = (uid: string | null, key: string): string | null =>
    attributeOf(uid, key)?.target ?? null;

  const isToMany = (uid: string | null, key: string): boolean => {
    const relation = attributeOf(uid, key)?.relation;
    return relation === "oneToMany" || relation === "manyToMany";
  };

  const isRelationKey = (uid: string | null, key: string, value: unknown): boolean => {
    const keys = uid ? relationKeys(uid) : null;
    if (keys) return keys.has(key);
    if (hasNumericId(value)) return true;
    return isList(value) && value.length > 0 && value.every(hasNumericId);
  };

  /** A condition object with at least one non-operator key is a where on related rows. */
  const isNestedWhere = (condition: unknown) =>
    isPlainObject(condition) && !Object.keys(condition).every(isOperator);

  const touchesRelation = (uid: string | null, row: Row, where: unknown): boolean => {
    if (isList(where)) return where.some((sub) => touchesRelation(uid, row, sub));
    if (!isPlainObject(where)) return false;
    return Object.entries(where).some(([key, condition]) => {
      if (key === "$and" || key === "$or" || key === "$not")
        return touchesRelation(uid, row, condition);
      if (isOperator(key)) return false;
      return isRelationKey(uid, key, row[key]) || isNestedWhere(condition);
    });
  };

  /**
   * A relation condition, like @strapi/database's processRelationWhere: a
   * scalar compares the related id, a single column operator applies to the
   * related id, anything else is a where clause on the related rows; a
   * to-many relation matches when ANY related row does (the engine joins
   * and adds DISTINCT). The join is a LEFT JOIN, so a row without related
   * rows is tested against one all-NULL related row.
   */
  const matchRelation = (targetUid: string | null, value: unknown, condition: unknown): boolean => {
    const found = relatedRows(targetUid, value);
    const related: Row[] = found.length > 0 ? found : [NULL_ROW];
    if (!isPlainObject(condition))
      return related.some((row) => matchOperator(row.id, "$eq", condition));
    const keys = Object.keys(condition);
    const operatorKeys = keys.filter(isOperator);
    if (operatorKeys.length > 0 && operatorKeys.length !== keys.length) {
      throw new Error("strapi-stub: operator and non-operator keys mixed in a relation where");
    }
    const [operator] = operatorKeys;
    if (
      operatorKeys.length === 1 &&
      operator !== "$and" &&
      operator !== "$or" &&
      operator !== "$not"
    ) {
      return related.some((row) => matchOperator(row.id, operator, condition[operator]));
    }
    return related.some((row) => matchWhere(targetUid, row, condition));
  };

  function matchWhere(
    uid: string | null,
    row: Row,
    where: Where | readonly Where[] | undefined,
  ): boolean {
    if (where === undefined) return true;
    if (isList(where)) return where.every((sub) => matchWhere(uid, row, sub as Where));
    if (!isPlainObject(where)) throw new Error("strapi-stub: where must be an object or an array");
    return Object.entries(where).every(([key, condition]) => {
      if (key === "$and")
        return castArray(condition).every((sub) => matchWhere(uid, row, sub as Where));
      if (key === "$or")
        return castArray(condition).some((sub) => matchWhere(uid, row, sub as Where));
      if (key === "$not") {
        // SQL evaluates NOT per joined row (a to-many row with ANY other
        // related row matches, a row with none does not): not modelled.
        if (touchesRelation(uid, row, condition)) {
          throw new Error(
            "strapi-stub: $not over a relation is not modelled (SQL NOT runs per joined row)",
          );
        }
        return !matchWhere(uid, row, condition as Where);
      }
      if (isOperator(key)) throw new Error(`strapi-stub: ${key} is not a root level operator`);
      const value = row[key];
      return isRelationKey(uid, key, value) || isNestedWhere(condition)
        ? matchRelation(targetOf(uid, key), value, condition)
        : matchColumn(value, condition);
    });
  }

  const populateEntries = (
    populate: Populate | undefined,
    row: Row,
    uid: string | null,
  ): Array<[string, PopulateOptions]> => {
    if (populate === undefined) return [];
    if (populate === true || populate === "*") {
      const keys = uid ? relationKeys(uid) : null;
      const all = keys
        ? [...keys]
        : Object.keys(row).filter((key) => isRelationKey(uid, key, row[key]));
      return all.map((key) => [key, {}]);
    }
    if (isList(populate)) return populate.map((key) => [String(key), {}]);
    return Object.entries(populate)
      .filter(([, options]) => options !== false)
      .map(([key, options]) => [key, options === true || options === false ? {} : options]);
  };

  const cloneValue = (value: unknown): unknown => {
    if (value instanceof Date) return new Date(value.getTime());
    return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
  };

  /**
   * The row as the query engine returns it: the selected scalar columns (all
   * of them without `select`) plus the populated relations, nothing else.
   */
  function project(
    uid: string | null,
    row: Row,
    select: string | readonly string[] | undefined,
    populate: Populate | undefined,
  ): Row {
    const out: Row = { id: row.id };
    const selected =
      select === undefined ? null : typeof select === "string" ? [select] : [...select];
    for (const [key, value] of Object.entries(row)) {
      if (isRelationKey(uid, key, value)) continue;
      if (selected && !selected.includes(key)) continue;
      out[key] = cloneValue(value);
    }
    const populated = populateEntries(populate, row, uid);
    // The engine adds `id` to a `select` only when it has relations to populate.
    if (selected && !selected.includes("id") && populated.length === 0) delete out.id;
    for (const [key, options] of populated) {
      const target = targetOf(uid, key);
      const value = row[key];
      if (isToMany(uid, key) || isList(value)) {
        let related = relatedRows(target, value);
        if (options.where)
          related = related.filter((item) => matchWhere(target, item, options.where));
        if (options.orderBy) related = sortRows(related, options.orderBy);
        out[key] = related.map((item) => project(target, item, options.select, options.populate));
      } else {
        const [related] = relatedRows(target, value);
        out[key] = related ? project(target, related, options.select, options.populate) : null;
      }
    }
    return out;
  }

  const orderEntries = (orderBy: OrderBy): Array<[string, Direction]> => {
    const entries: Array<[string, Direction]> = [];
    const items: readonly unknown[] = isList(orderBy) ? orderBy : [orderBy];
    for (const item of items) {
      if (typeof item === "string") entries.push([item, "asc"]);
      else if (isPlainObject(item)) {
        for (const [key, direction] of Object.entries(item))
          entries.push([key, direction === "desc" ? "desc" : "asc"]);
      }
    }
    return entries;
  };

  function sortRows(rows: Row[], orderBy: OrderBy | undefined): Row[] {
    const entries: Array<[string, Direction]> =
      orderBy === undefined ? [["id", "asc"]] : orderEntries(orderBy);
    return [...rows].sort((a, b) => {
      for (const [key, direction] of entries) {
        const x = comparable(a[key]);
        const y = comparable(b[key]);
        if (x === y) continue;
        const sign = direction === "asc" ? 1 : -1;
        // NULLs sort first ascending, as on SQLite (Postgres sorts them last).
        if (x === null) return -sign;
        if (y === null) return sign;
        return (x < y ? -1 : 1) * sign;
      }
      return 0;
    });
  }

  return { matchWhere, project, sortRows, relationKeys };
}

/** The evaluator over this cms's real schemas. */
export const matchWhere = createEvaluator(CMS_SCHEMAS).matchWhere;

// ---------------------------------------------------------------------------
// The stub
// ---------------------------------------------------------------------------

const FIXED_NOW = "2026-09-28T08:00:00.000Z";

/** A documentId in the shape Strapi 5 generates (utils/entry-id.ts): a letter + 23 [a-z0-9]. */
export function stubDocumentId(n: number): string {
  return `d${String(n).padStart(23, "0")}`;
}

function copyTables(tables: Tables | undefined): Tables {
  const out: Tables = {};
  for (const [uid, rows] of Object.entries(tables ?? {})) {
    out[uid] = rows.map((row) => JSON.parse(JSON.stringify(row)) as Row);
  }
  return out;
}

const isPublishedRow = (row: Row) => !isNull(row.publishedAt);

export function createStrapiStub(options: StrapiStubOptions = {}): StrapiStub {
  const schemas: Record<string, ContentTypeSchema> = { ...CMS_SCHEMAS, ...options.schemas };
  const evaluator = createEvaluator(schemas, (uid, id) =>
    tables[uid]?.find((row) => row.id === id),
  );
  const tables = copyTables(options.tables);
  const calls: StubCall[] = [];
  const now = options.now ?? (() => FIXED_NOW);
  const highestId: Record<string, number> = {};
  let documentCounter = 0;

  const rowsOf = (uid: string): Row[] => (tables[uid] ??= []);

  /** Ids are never reused, like AUTOINCREMENT / serial. */
  const nextId = (uid: string): number => {
    const current = Math.max(highestId[uid] ?? 0, ...rowsOf(uid).map((row) => row.id));
    highestId[uid] = current + 1;
    return highestId[uid];
  };

  /** A bare id for a relation key becomes `{ id }`; a list of ids a list of `{ id }`. */
  const normaliseData = (uid: string, data: Record<string, unknown>): Record<string, unknown> => {
    const relations = evaluator.relationKeys(uid);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const relation = relations?.has(key) ?? false;
      if (relation && typeof value === "number") out[key] = { id: value };
      else if (relation && isList(value))
        out[key] = value.map((item) => (typeof item === "number" ? { id: item } : item));
      else out[key] = value;
    }
    return out;
  };

  const hasDraftAndPublish = (uid: string): boolean => {
    const schema = schemas[uid];
    if (!schema)
      throw new Error(
        `strapi-stub: unknown content type ${uid} (pass its schema in options.schemas)`,
      );
    return schema.options?.draftAndPublish === true;
  };

  const selectRows = (uid: string, params: QueryParams | undefined): Row[] => {
    let rows = rowsOf(uid).filter((row) => evaluator.matchWhere(uid, row, params?.where));
    rows = evaluator.sortRows(rows, params?.orderBy);
    if (params?.offset) rows = rows.slice(params.offset);
    if (params?.limit !== undefined) rows = rows.slice(0, params.limit);
    return rows;
  };

  const project = (uid: string, row: Row, params: QueryParams | undefined) =>
    evaluator.project(uid, row, params?.select, params?.populate);

  const insert = (uid: string, data: Record<string, unknown>): Row => {
    const row: Row = { ...normaliseData(uid, data), id: nextId(uid) };
    rowsOf(uid).push(row);
    return row;
  };

  const remove = (uid: string, predicate: (row: Row) => boolean): Row[] => {
    const rows = rowsOf(uid);
    const removed = rows.filter(predicate);
    tables[uid] = rows.filter((row) => !predicate(row));
    return removed;
  };

  const record = (api: StubCall["api"], uid: string, method: string, params: unknown) => {
    calls.push({ api, uid, method, params });
  };

  const query = (uid: string): StubQuery => ({
    async findOne(params) {
      record("db", uid, "findOne", params);
      const [row] = selectRows(uid, params);
      return row ? project(uid, row, params) : null;
    },
    async findMany(params) {
      record("db", uid, "findMany", params);
      return selectRows(uid, params).map((row) => project(uid, row, params));
    },
    async count(params) {
      record("db", uid, "count", params);
      return selectRows(uid, params).length;
    },
    async create(params) {
      record("db", uid, "create", params);
      return project(uid, insert(uid, params.data), params);
    },
    async update(params) {
      record("db", uid, "update", params);
      const [row] = selectRows(uid, params);
      if (!row) return null;
      Object.assign(row, normaliseData(uid, params.data));
      return project(uid, row, params);
    },
    async updateMany(params) {
      record("db", uid, "updateMany", params);
      const rows = rowsOf(uid).filter((row) => evaluator.matchWhere(uid, row, params.where));
      for (const row of rows) Object.assign(row, normaliseData(uid, params.data));
      return { count: rows.length };
    },
    async delete(params) {
      record("db", uid, "delete", params);
      const [row] = selectRows(uid, params);
      if (!row) return null;
      remove(uid, (candidate) => candidate === row);
      return project(uid, row, params);
    },
    async deleteMany(params) {
      record("db", uid, "deleteMany", params);
      return { count: remove(uid, (row) => evaluator.matchWhere(uid, row, params?.where)).length };
    },
  });

  // Documents ---------------------------------------------------------------

  const documentRows = (uid: string, documentId: string) =>
    rowsOf(uid).filter((row) => row.documentId === documentId);
  const draftOf = (uid: string, documentId: string) =>
    documentRows(uid, documentId).find((row) => !isPublishedRow(row)) ?? null;
  const publishedOf = (uid: string, documentId: string) =>
    documentRows(uid, documentId).find(isPublishedRow) ?? null;

  const cloneAs = (uid: string, source: Row, publishedAt: string | null): Row => {
    const { id: _id, ...fields } = JSON.parse(JSON.stringify(source)) as Row;
    return insert(uid, { ...fields, publishedAt, updatedAt: now() });
  };

  /** Document Service default: the draft. Types without draft & publish ignore status. */
  const statusWhere = (uid: string, status: DocumentStatus | undefined): Where => {
    if (!hasDraftAndPublish(uid)) return {};
    return status === "published"
      ? { publishedAt: { $notNull: true } }
      : { publishedAt: { $null: true } };
  };

  const documentWhere = (uid: string, params: DocumentParams): Where => ({
    $and: [
      ...(params.documentId === undefined ? [] : [{ documentId: params.documentId }]),
      statusWhere(uid, params.status),
      params.filters ?? {},
    ],
  });

  const documentProjection = (params: DocumentParams): QueryParams => ({
    select: params.fields ? [...params.fields, "id", "documentId"] : undefined,
    populate: params.populate,
  });

  const seedDocument: StrapiStub["seedDocument"] = (uid, data, seedOptions = {}) => {
    documentCounter += 1;
    const documentId = seedOptions.documentId ?? stubDocumentId(documentCounter);
    const stamp = now();
    const base = { createdAt: stamp, updatedAt: stamp, ...data, documentId };
    if (!hasDraftAndPublish(uid)) {
      return { documentId, draft: null, published: insert(uid, { ...base, publishedAt: stamp }) };
    }
    const draft = insert(uid, { ...base, publishedAt: null });
    const published =
      seedOptions.status === "published" ? insert(uid, { ...base, publishedAt: stamp }) : null;
    return { documentId, draft, published };
  };

  /** Publish = delete the published row + recreate it from the draft (a NEW id). */
  const publishDocument = (uid: string, documentId: string): Row[] => {
    const draft = draftOf(uid, documentId);
    if (!draft) return [];
    remove(uid, (row) => row.documentId === documentId && isPublishedRow(row));
    return [cloneAs(uid, draft, now())];
  };

  const documents = (uid: string): StubDocuments => ({
    async findOne(params) {
      record("documents", uid, "findOne", params);
      const [row] = selectRows(uid, { where: documentWhere(uid, params) });
      return row ? project(uid, row, documentProjection(params)) : null;
    },
    async findFirst(params = {}) {
      record("documents", uid, "findFirst", params);
      const [row] = selectRows(uid, { where: documentWhere(uid, params), orderBy: params.sort });
      return row ? project(uid, row, documentProjection(params)) : null;
    },
    async findMany(params = {}) {
      record("documents", uid, "findMany", params);
      return selectRows(uid, { where: documentWhere(uid, params), orderBy: params.sort }).map(
        (row) => project(uid, row, documentProjection(params)),
      );
    },
    async count(params = {}) {
      record("documents", uid, "count", params);
      return selectRows(uid, { where: documentWhere(uid, params) }).length;
    },
    async create(params) {
      record("documents", uid, "create", params);
      const seeded = seedDocument(uid, params.data, { status: params.status });
      const row =
        params.status === "published" || !hasDraftAndPublish(uid) ? seeded.published : seeded.draft;
      if (!row) throw new Error("strapi-stub: create produced no row");
      return project(uid, row, documentProjection(params));
    },
    async update(params) {
      record("documents", uid, "update", params);
      if (documentRows(uid, params.documentId).length === 0) return null;
      if (!hasDraftAndPublish(uid)) {
        const [row] = documentRows(uid, params.documentId);
        Object.assign(row, normaliseData(uid, params.data), { updatedAt: now() });
        return project(uid, row, documentProjection(params));
      }
      let draft = draftOf(uid, params.documentId);
      if (draft) {
        Object.assign(draft, normaliseData(uid, params.data), { updatedAt: now() });
      } else {
        // Strapi 5.55.1: no draft row -> a new draft from the payload ONLY
        // (document-service repository.js update, the FX38 root cause).
        const stamp = now();
        draft = insert(uid, {
          ...params.data,
          documentId: params.documentId,
          publishedAt: null,
          createdAt: stamp,
          updatedAt: stamp,
        });
      }
      if (params.status === "published") {
        const [published] = publishDocument(uid, params.documentId);
        return project(uid, published, documentProjection(params));
      }
      return project(uid, draft, documentProjection(params));
    },
    async delete(params) {
      record("documents", uid, "delete", params);
      return {
        documentId: params.documentId,
        entries: remove(uid, (row) => row.documentId === params.documentId),
      };
    },
    async publish(params) {
      record("documents", uid, "publish", params);
      return { documentId: params.documentId, entries: publishDocument(uid, params.documentId) };
    },
    async unpublish(params) {
      record("documents", uid, "unpublish", params);
      const entries = remove(
        uid,
        (row) => row.documentId === params.documentId && isPublishedRow(row),
      );
      return { documentId: params.documentId, entries };
    },
    async discardDraft(params) {
      record("documents", uid, "discardDraft", params);
      const published = publishedOf(uid, params.documentId);
      if (!published) return { documentId: params.documentId, entries: [] };
      remove(uid, (row) => row.documentId === params.documentId && !isPublishedRow(row));
      return { documentId: params.documentId, entries: [cloneAs(uid, published, null)] };
    },
  });

  // Transactions --------------------------------------------------------------

  let depth = 0;
  let commitQueue: Array<() => unknown> = [];
  let rollbackQueue: Array<() => unknown> = [];

  const transaction = async <T>(
    callback: (scope: TransactionScope) => Promise<T> | T,
  ): Promise<T> => {
    if (depth === 0) {
      commitQueue = [];
      rollbackQueue = [];
    }
    depth += 1;
    const scope: TransactionScope = {
      trx: { stubTransaction: true },
      onCommit: (cb) => {
        commitQueue.push(cb);
      },
      onRollback: (cb) => {
        rollbackQueue.push(cb);
      },
    };
    try {
      const result = await callback(scope);
      depth -= 1;
      if (depth === 0) for (const cb of commitQueue.splice(0)) await cb();
      return result;
    } catch (error) {
      depth -= 1;
      if (depth === 0) for (const cb of rollbackQueue.splice(0)) await cb();
      throw error;
    }
  };

  // Services ------------------------------------------------------------------

  const plugin = (name: string) => ({
    service(serviceName: string): object {
      const found = options.plugins?.[name]?.[serviceName];
      if (!found)
        throw new Error(`strapi-stub: plugin service ${name}.${serviceName} is not stubbed`);
      return found;
    },
  });

  const service = (uid: string): object => {
    const found = options.services?.[uid];
    if (!found) throw new Error(`strapi-stub: service ${uid} is not stubbed`);
    return found;
  };

  const log: StubLog = {
    debug: vi.fn<LogFn>(),
    info: vi.fn<LogFn>(),
    warn: vi.fn<LogFn>(),
    error: vi.fn<LogFn>(),
  };

  return {
    db: { query, transaction, inTransaction: () => depth > 0 },
    documents,
    plugin,
    service,
    contentType: (uid) => schemas[uid],
    getModel: (uid) => schemas[uid],
    requestContext: { get: () => options.requestContext },
    log,
    calls,
    tables,
    hasDraftAndPublish,
    seedDocument,
  };
}

// ---------------------------------------------------------------------------
// Policy contexts
// ---------------------------------------------------------------------------

/** The caller as users-permissions puts it on ctx.state.user. */
export interface StubUser {
  id?: number;
  role?: { id?: number; type?: string } | null;
}

export interface StubPolicyContext {
  state?: { user?: StubUser | null };
  params?: Record<string, unknown>;
  request: { query: Record<string, unknown>; body?: unknown };
  /**
   * An own `query` property, as createPolicyContext's Object.assign leaves
   * it: a copy the controller never reads (§5.14). Tests set a decoy here.
   */
  query?: Record<string, unknown>;
}

export interface PolicyContextOptions {
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  body?: unknown;
  decoy?: Record<string, unknown>;
}

/**
 * A policy context shaped like createPolicyContext('koa', ctx): `request`
 * is Koa's ctx.request (shared with the controller), `query` a decoy.
 * `user` undefined = no `state` at all, null = `state` without a user.
 */
export function policyContext(
  user: StubUser | null | undefined,
  options: PolicyContextOptions = {},
): StubPolicyContext {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  return {
    ...(user === undefined ? {} : { state: user === null ? {} : { user } }),
    ...(options.params ? { params: options.params } : {}),
    request: {
      query: clone(options.query ?? {}),
      ...(options.body === undefined ? {} : { body: clone(options.body) }),
    },
    ...(options.decoy ? { query: options.decoy } : {}),
  };
}
