/**
 * Test support for the targeting flags and the department and team delete
 * hooks (utils/targeting-flags.ts, the department and team lifecycles):
 * the shared Strapi stub, plus what the hooks need on top of it. Named
 * *.test.helper.ts so the Strapi build skips it and Vitest does not collect
 * it as a suite.
 *
 *   - the link tables of every relation the hooks read
 *     (`<table>_<attribute>_lnk`, as @strapi/database registers them), built
 *     from the rows' embedded relations, and `db.metadata.get(uid)` naming
 *     them the way the query engine's metadata does;
 *   - `db.dialect.client` and `db.queryBuilder(uid)…forUpdate().execute()`,
 *     which records the row locks;
 *   - `events`: one ordered log of row locks ("lock-rows <uid> <ids>"),
 *     link and row reads ("read <uid>") and flag writes ("update <uid>"), so
 *     a test can assert what happened before what. The revision API is
 *     mocked by the suites (vi.mock of document-lock), which push
 *     "revision <uid> <documentId>" into the same log through `record`.
 */
import { vi } from "vitest";

import {
  createStrapiStub,
  type Row,
  type StrapiStub,
  type Tables,
} from "../test/strapi-stub.test.helper";

export const ANNOUNCEMENT = "api::announcement.announcement";
export const EVENT = "api::event.event";
export const DOCUMENT = "api::document.document";
export const QUICK_LINK = "api::quick-link.quick-link";
export const POLL = "api::poll.poll";
export const DEPARTMENT = "api::department.department";
export const TEAM = "api::team.team";
export const WIKI_PAGE = "api::wiki-page.wiki-page";

interface LinkSpec {
  table: string;
  rowColumn: string;
  targetColumn: string;
}

/** The link tables the hooks read, per content type and relation. */
export const LINK_TABLES: Record<string, Record<string, LinkSpec>> = {
  [ANNOUNCEMENT]: {
    department: {
      table: "announcements_department_lnk",
      rowColumn: "announcement_id",
      targetColumn: "department_id",
    },
    team: {
      table: "announcements_team_lnk",
      rowColumn: "announcement_id",
      targetColumn: "team_id",
    },
    ownerDepartment: {
      table: "announcements_owner_department_lnk",
      rowColumn: "announcement_id",
      targetColumn: "department_id",
    },
  },
  [EVENT]: {
    departments: {
      table: "events_departments_lnk",
      rowColumn: "event_id",
      targetColumn: "department_id",
    },
    ownerDepartment: {
      table: "events_owner_department_lnk",
      rowColumn: "event_id",
      targetColumn: "department_id",
    },
  },
  [DOCUMENT]: {
    departments: {
      table: "documents_departments_lnk",
      rowColumn: "document_id",
      targetColumn: "department_id",
    },
    ownerDepartment: {
      table: "documents_owner_department_lnk",
      rowColumn: "document_id",
      targetColumn: "department_id",
    },
  },
  [QUICK_LINK]: {
    departments: {
      table: "quick_links_departments_lnk",
      rowColumn: "quick_link_id",
      targetColumn: "department_id",
    },
  },
  [POLL]: {
    departments: {
      table: "polls_departments_lnk",
      rowColumn: "poll_id",
      targetColumn: "department_id",
    },
  },
  [WIKI_PAGE]: {
    department: {
      table: "wiki_pages_department_lnk",
      rowColumn: "wiki_page_id",
      targetColumn: "department_id",
    },
    team: {
      table: "wiki_pages_team_lnk",
      rowColumn: "wiki_page_id",
      targetColumn: "team_id",
    },
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The ids an embedded relation value links (`{ id }` or `[{ id }]`). */
const linkedIds = (value: unknown): number[] =>
  (Array.isArray(value) ? value : value == null ? [] : [value])
    .map((entry) => (isRecord(entry) ? entry.id : undefined))
    .filter((id): id is number => typeof id === "number");

/** The link table rows of `tables`, from the content rows' embedded relations. */
export function linkTablesOf(tables: Tables): Tables {
  const out: Tables = {};
  for (const [uid, relations] of Object.entries(LINK_TABLES)) {
    for (const [attribute, spec] of Object.entries(relations)) {
      const rows: Row[] = [];
      for (const row of tables[uid] ?? []) {
        for (const targetId of linkedIds(row[attribute])) {
          rows.push({
            id: rows.length + 1,
            [spec.rowColumn]: row.id,
            [spec.targetColumn]: targetId,
          });
        }
      }
      out[spec.table] = rows;
    }
  }
  return out;
}

/** What @strapi/database's metadata says about a type's link tables. */
export function metadataOf(uid: string): unknown {
  const relations = LINK_TABLES[uid];
  if (!relations) return { attributes: {} };
  return {
    attributes: Object.fromEntries(
      Object.entries(relations).map(([attribute, spec]) => [
        attribute,
        {
          joinTable: {
            name: spec.table,
            joinColumn: { name: spec.rowColumn },
            inverseJoinColumn: { name: spec.targetColumn },
          },
        },
      ]),
    ),
  };
}

export interface DeleteHost {
  strapi: StrapiStub & {
    db: StrapiStub["db"] & {
      metadata: { get(uid: string): unknown };
      dialect: { client: string };
      queryBuilder(uid: string): unknown;
    };
  };
  events: string[];
  record(event: string): void;
  /** The rows of `uid` as [id, ...values of `keys`]. */
  values(uid: string, keys: string[]): unknown[][];
}

/**
 * The stub with link tables, metadata, a dialect and a recording query
 * builder. `failOn` makes the first flag write (`updateMany`) of that uid
 * throw.
 */
export function deleteHost(
  tables: Tables,
  options: {
    dialect?: string;
    metadata?: (uid: string) => unknown;
    failOn?: string;
  } = {},
): DeleteHost {
  const stub = createStrapiStub({ tables: { ...tables, ...linkTablesOf(tables) } });
  const events: string[] = [];
  const record = (event: string) => events.push(event);
  const query = stub.db.query.bind(stub.db);
  const db = stub.db as DeleteHost["strapi"]["db"];
  db.query = (uid: string) => {
    const inner = query(uid);
    return {
      ...inner,
      findMany: async (params) => {
        record(`read ${uid}`);
        return inner.findMany(params);
      },
      updateMany: async (params) => {
        if (options.failOn === uid) throw new Error(`update of ${uid} failed`);
        record(`update ${uid}`);
        return inner.updateMany(params);
      },
    };
  };
  db.metadata = { get: options.metadata ?? metadataOf };
  db.dialect = { client: options.dialect ?? "sqlite" };
  db.queryBuilder = (uid: string) => {
    let ids: unknown = null;
    const builder = {
      select: () => builder,
      where: (where: { id?: { $in?: unknown } }) => {
        ids = where.id?.$in;
        return builder;
      },
      forUpdate: () => builder,
      execute: vi.fn(async () => {
        record(`lock-rows ${uid} ${JSON.stringify(ids)}`);
        return [];
      }),
    };
    return builder;
  };
  return {
    strapi: stub as DeleteHost["strapi"],
    events,
    record,
    values: (uid, keys) =>
      (stub.tables[uid] ?? [])
        .slice()
        .sort((a, b) => a.id - b.id)
        .map((row) => [row.id, ...keys.map((key) => row[key] ?? null)]),
  };
}
