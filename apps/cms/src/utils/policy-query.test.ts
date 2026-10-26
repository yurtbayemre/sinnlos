import { errors } from "@strapi/utils";
import { describe, expect, it, vi } from "vitest";
import {
  canNarrow,
  createVisibilityNarrowing,
  forcePublishedStatus,
  getMutableQuery,
  narrowFilters,
  narrowReads,
  oneParamIn,
  restrictiveIdFilter,
} from "./policy-query";

/**
 * Guards the sanitize fail-open fix: @strapi/utils' defaultSanitizeFilters
 * strips empty array operands, so `{ id: { $in: [] } }` would degrade to
 * `{ id: {} }` (no filter at all). The empty case must therefore be a
 * scalar, non-empty operand that can never match.
 */
describe("restrictiveIdFilter", () => {
  it("keeps $in for a non-empty id list", () => {
    expect(restrictiveIdFilter([3, 7])).toEqual({ id: { $in: [3, 7] } });
  });

  it("emits a sanitize-proof scalar clause for an empty id list", () => {
    const filter = restrictiveIdFilter([]);
    expect(filter).toEqual({ id: { $eq: -1 } });
    // Must NOT be an array operand — sanitizeQuery removes empty arrays.
    expect(Array.isArray((filter.id as Record<string, unknown>).$eq)).toBe(false);
  });
});

/**
 * Guards the draft-read fix: the id-based policies resolve their ids via
 * `strapi.db.query`, which returns draft AND published rows, so the
 * publication state is decided solely by the client-controllable `status`
 * param (validateQuery allows it, sanitizeQuery passes it through, and the
 * core service merges it over its own `status: 'published'` default).
 */
describe("forcePublishedStatus", () => {
  it("overwrites a client-supplied status=draft", () => {
    const query: Record<string, any> = { status: "draft", filters: { id: { $in: [1] } } };
    forcePublishedStatus(query);
    expect(query.status).toBe("published");
    // The filter the policy already injected must survive untouched.
    expect(query.filters).toEqual({ id: { $in: [1] } });
  });

  it("sets the status when the client sent none", () => {
    const query: Record<string, any> = {};
    forcePublishedStatus(query);
    expect(query.status).toBe("published");
  });

  it("deletes the legacy v4 publicationState param", () => {
    const query: Record<string, any> = { publicationState: "preview" };
    forcePublishedStatus(query);
    expect("publicationState" in query).toBe(false);
  });

  it("deletes the publicationFilter and hasPublishedVersion params", () => {
    // Both are content-api keys the document service turns into a
    // publication-cohort filter; non-bypass readers must not steer it.
    const query: Record<string, unknown> = {
      status: "draft",
      publicationFilter: "modified",
      hasPublishedVersion: "true",
      filters: { id: { $in: [1] } },
    };
    forcePublishedStatus(query);
    expect(query.status).toBe("published");
    expect("publicationFilter" in query).toBe(false);
    expect("hasPublishedVersion" in query).toBe(false);
    expect(query.filters).toEqual({ id: { $in: [1] } });
  });

  it("mutates in place — the controller reads the SAME object", () => {
    // Returning a copy would be the policyContext.query no-op all over
    // again: sanitizeQuery/validateQuery read `ctx.request.query`.
    const query: Record<string, any> = { status: "draft" };
    const same = query;
    forcePublishedStatus(query);
    expect(same.status).toBe("published");
  });
});

/**
 * Guards the policy-context no-op fix (issue #24, trap a): the visibility
 * policies must mutate the SAME query object the core controller later reads
 * through `ctx.query` → `ctx.request.query`. `createPolicyContext`'s
 * `Object.assign` copies `request` by reference (own property) but NOT the
 * `query` prototype getter, so the injected filter/status has to land on
 * `policyContext.request.query`; writing to a fresh `policyContext.query`
 * would be a silent no-op. `getMutableQuery` returns exactly that stable,
 * mutable reference.
 */
describe("getMutableQuery", () => {
  it("returns the SAME request.query reference so mutations reach the controller", () => {
    // Trap (a): identity matters. The controller reads ctx.request.query, so
    // the object we hand back must BE that object, not a copy.
    const existing: Record<string, any> = { filters: { requiresAck: { $eq: true } } };
    const policyContext: any = { request: { query: existing } };

    const query = getMutableQuery(policyContext);

    expect(query).toBe(existing);
    // A filter/status written through the returned handle is observed on the
    // real request query the controller later validates & sanitizes.
    query.filters = { id: { $in: [1, 2] } };
    query.status = "published";
    expect(policyContext.request.query.filters).toEqual({ id: { $in: [1, 2] } });
    expect(policyContext.request.query.status).toBe("published");
  });

  it("creates request.query when the request carries none and returns THAT object", () => {
    // Real Koa always exposes request.query, but a non-Koa stub may not; the
    // handle we return must still be the one that lives on request.query so
    // the write lands on the controller's read path.
    const policyContext: any = { request: {} };

    const query = getMutableQuery(policyContext);

    expect(policyContext.request.query).toBe(query);
    query.filters = { id: { $eq: -1 } };
    expect(policyContext.request.query.filters).toEqual({ id: { $eq: -1 } });
  });

  it("falls back to policyContext.query for a non-Koa context without request", () => {
    // No `request` object at all → last-resort fallback returns the bare
    // ctx.query as-is (===). This is the documented non-Koa escape hatch, not
    // the Koa path; it does NOT synthesise a `request`.
    const bare: Record<string, any> = { status: "draft" };
    const policyContext: any = { query: bare };

    const query = getMutableQuery(policyContext);

    expect(query).toBe(bare);
    expect("request" in policyContext).toBe(false);
  });

  it("creates policyContext.query when neither request nor query exist", () => {
    const policyContext: any = {};

    const query = getMutableQuery(policyContext);

    expect(policyContext.query).toBe(query);
    expect(query).toEqual({});
  });
});

/**
 * narrowFilters (PL01): the injected clause is $and-composed with the
 * client filter, never spread-merged, so a client key can neither replace
 * the policy's clause nor sit next to it as an alternative.
 */
describe("narrowFilters", () => {
  const clause = { user: { id: 7 } };

  it("stands alone without a client filter (never an empty $and)", () => {
    for (const filters of [undefined, null, ""]) {
      const query: Record<string, unknown> = filters === undefined ? {} : { filters };
      narrowFilters(query, clause);
      expect(query.filters, String(filters)).toBe(clause);
    }
  });

  it("refuses scalar client filters before wrapping them in $and", () => {
    for (const filters of ['{"quiz":{"$notNull":true}}', "bad filter", true, 1]) {
      const query = { filters };
      expect(() => narrowFilters(query, clause)).toThrow(errors.ValidationError);
      expect(query.filters).toBe(filters);
    }
    const filters = [{ title: { $eq: "x" } }];
    const query: Record<string, unknown> = { filters };
    narrowFilters(query, clause);
    expect(query.filters).toEqual({ $and: [filters, clause] });
  });

  it("wraps the client filter and the clause in one $and, client first", () => {
    const client = { title: { $eq: "x" } };
    const query: Record<string, unknown> = { filters: client };
    narrowFilters(query, clause);
    expect(query.filters).toEqual({ $and: [client, clause] });
    expect((query.filters as { $and: unknown[] }).$and[0]).toBe(client);
  });

  it("keeps a client key of the same name as a separate operand", () => {
    // A spread merge would let `user` of one side overwrite the other.
    const client = { user: { id: 99 }, $or: [{ id: 1 }, { id: 2 }] };
    const query: Record<string, unknown> = { filters: client };
    narrowFilters(query, clause);
    expect(query.filters).toEqual({ $and: [client, { user: { id: 7 } }] });
  });

  it("nests on repeated calls instead of flattening", () => {
    const query: Record<string, unknown> = { filters: { a: 1 } };
    narrowFilters(query, { b: 2 });
    narrowFilters(query, { c: 3 });
    expect(query.filters).toEqual({ $and: [{ $and: [{ a: 1 }, { b: 2 }] }, { c: 3 }] });
  });

  it("writes onto the query it is given (the real request query)", () => {
    const ctx = { request: { query: { filters: { a: 1 } } as Record<string, unknown> } };
    narrowFilters(getMutableQuery(ctx), clause);
    expect(ctx.request.query.filters).toEqual({ $and: [{ a: 1 }, clause] });
  });
});

/**
 * The one-parameter list (#175): a whole list as ONE bound parameter, so a
 * read policy has no bind limit to fail at.
 */
describe("oneParamIn", () => {
  const host = (client?: string) => {
    const raw = vi.fn((sql: string, bindings: unknown[]) => ({ sql, bindings }));
    return {
      raw,
      strapi: { db: { dialect: client ? { client } : undefined, connection: { raw } } },
    };
  };

  it("binds a Postgres array: unnest(?::int[]) or ?::text[], one binding", () => {
    const { raw, strapi } = host("postgres");
    oneParamIn(strapi, [3, 1, 2], "int");
    oneParamIn(strapi, ["a", "b"], "text");
    expect(raw.mock.calls).toEqual([
      ["select unnest(?::int[])", [[3, 1, 2]]],
      ["select unnest(?::text[])", [["a", "b"]]],
    ]);
  });

  it("binds one JSON text elsewhere: json_each(?), the SQLite way", () => {
    for (const client of ["sqlite", undefined]) {
      const { raw, strapi } = host(client);
      oneParamIn(strapi, [1, 2], "int");
      oneParamIn(strapi, [], "text");
      expect(raw.mock.calls).toEqual([
        ["select value from json_each(?)", ["[1,2]"]],
        ["select value from json_each(?)", ["[]"]],
      ]);
    }
  });

  it("keeps 70,000 values in one binding", () => {
    const { raw, strapi } = host("postgres");
    const ids = Array.from({ length: 70_000 }, (_, index) => index + 1);
    oneParamIn(strapi, ids, "int");
    const bindings = raw.mock.calls[0][1];
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toEqual(ids);
  });
});

/**
 * The request-stored clause (#175): a read policy leaves it on ctx.state,
 * and the Document Service middleware ANDs it into the reads of its uid.
 */
describe("visibility narrowing", () => {
  const UID = "api::document.document";
  const request = () => ({ state: {} as Record<PropertyKey, unknown> });
  const host = (ctx: unknown) => ({ requestContext: { get: () => ctx } });
  const run = async (
    strapi: ReturnType<typeof host>,
    context: { uid?: string; action?: string; params?: unknown },
  ) => {
    const next = vi.fn(async () => "result");
    await expect(createVisibilityNarrowing(strapi)(context, next)).resolves.toBe("result");
    expect(next).toHaveBeenCalledTimes(1);
    return context.params;
  };

  it("needs the request context the policy runs in", () => {
    const ctx = request();
    expect(canNarrow(host(ctx), ctx.state)).toBe(true);
    expect(canNarrow(host(undefined), ctx.state)).toBe(false);
    expect(canNarrow({}, ctx.state)).toBe(false);
    expect(canNarrow(host({ state: {} }), ctx.state)).toBe(false);
    expect(canNarrow(host({}), undefined)).toBe(false);
    expect(narrowReads(host(undefined), ctx.state, UID, { id: 1 })).toBe(false);
  });

  it("ANDs the stored clauses into the reads of their uid, list and count alike", async () => {
    const ctx = request();
    const strapi = host(ctx);
    expect(narrowReads(strapi, ctx.state, UID, { id: { $in: "A" } })).toBe(true);
    expect(narrowReads(strapi, ctx.state, UID, { id: { $in: "B" } })).toBe(true);
    for (const action of ["findMany", "findOne", "findFirst", "count"]) {
      await expect(run(strapi, { uid: UID, action, params: {} })).resolves.toEqual({
        filters: { $and: [{ id: { $in: "A" } }, { id: { $in: "B" } }] },
      });
    }
  });

  it("keeps the client's filters and the other params, the clause after them", async () => {
    const ctx = request();
    const strapi = host(ctx);
    narrowReads(strapi, ctx.state, UID, { id: { $in: "A" } });
    const params = { documentId: "doc", filters: { title: "x" }, status: "published" };
    await expect(run(strapi, { uid: UID, action: "findOne", params })).resolves.toEqual({
      documentId: "doc",
      filters: { $and: [{ title: "x" }, { id: { $in: "A" } }] },
      status: "published",
    });
    await expect(run(strapi, { uid: UID, action: "findMany" })).resolves.toEqual({
      filters: { id: { $in: "A" } },
    });
  });

  it("refuses a scalar client filter it would have to wrap (400, fail closed)", async () => {
    const ctx = request();
    const strapi = host(ctx);
    narrowReads(strapi, ctx.state, UID, { id: { $in: "A" } });
    const next = vi.fn(async () => "result");
    await expect(
      createVisibilityNarrowing(strapi)(
        { uid: UID, action: "findMany", params: { filters: "title" } },
        next,
      ),
    ).rejects.toBeInstanceOf(errors.ValidationError);
    expect(next).not.toHaveBeenCalled();
  });

  it("leaves writes, other uids and requests without a clause alone", async () => {
    const ctx = request();
    const strapi = host(ctx);
    narrowReads(strapi, ctx.state, UID, { id: { $in: "A" } });
    const params = { filters: { title: "x" } };
    for (const action of ["create", "update", "delete", "publish"]) {
      await expect(run(strapi, { uid: UID, action, params })).resolves.toBe(params);
    }
    await expect(run(strapi, { uid: "api::poll.poll", action: "findMany", params })).resolves.toBe(
      params,
    );
    await expect(run(host(request()), { uid: UID, action: "findMany", params })).resolves.toBe(
      params,
    );
    await expect(run(host(undefined), { uid: UID, action: "findMany", params })).resolves.toBe(
      params,
    );
  });
});
