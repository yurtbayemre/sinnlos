import { describe, expect, it } from "vitest";
import { strapiQuery, withQuery } from "./query";

/**
 * The query encoder (WD01): structure parts go out as written (and must
 * be safe to), values are always percent-encoded, parameters keep the
 * order of the calls. lib/strapi-urls.test.ts pins every real read; these
 * cases pin the rules themselves.
 */

describe("strapiQuery — values are always percent-encoded", () => {
  it("encodes filter values, whatever they contain", () => {
    const q = strapiQuery()
      .filter("slug", "$eq", "r&d = 100%?#x")
      .filter(["$or", 0, "start"], "$gte", "2026-09-28T10:00:00.000Z")
      .filter(["space", "slug"], "$eq", "a/b c");
    expect(q.toString()).toBe(
      "filters[slug][$eq]=r%26d%20%3D%20100%25%3F%23x" +
        "&filters[$or][0][start][$gte]=2026-09-28T10%3A00%3A00.000Z" +
        "&filters[space][slug][$eq]=a%2Fb%20c",
    );
  });

  it("writes numbers and booleans as they print", () => {
    expect(
      strapiQuery()
        .filter("requiresAck", "$eq", true)
        .filter(["author", "id"], "$eq", 7)
        .filter("readAt", "$null", true)
        .toString(),
    ).toBe("filters[requiresAck][$eq]=true&filters[author][id][$eq]=7&filters[readAt][$null]=true");
  });

  it("indexes $in values and encodes each", () => {
    expect(strapiQuery().filterIn("targetDocumentId", ["a b", "c&d"]).toString()).toBe(
      "filters[targetDocumentId][$in][0]=a%20b&filters[targetDocumentId][$in][1]=c%26d",
    );
    expect(strapiQuery().filterIn("x", []).toString()).toBe("");
  });

  it("joins a list parameter with literal commas between encoded values", () => {
    expect(strapiQuery().list("ids", ["k3m9", "a,b", 7]).toString()).toBe("ids=k3m9,a%2Cb,7");
  });
});

describe("strapiQuery — structure goes out as written", () => {
  it("builds fields, populates, sorts and pagination", () => {
    const q = strapiQuery()
      .fields(["title", "slug"])
      .populate("head")
      .populate(["teams", "lead"])
      .populateFields("author", ["displayName", "jobTitle"])
      .populateFields(["manager", "avatar"], ["url"])
      .sort(["name:asc", "id:asc"])
      .sortBy("pinned:desc,createdAt:desc")
      .page(2, 100)
      .pageSize(5)
      .literal("window", 30);
    expect(q.toString()).toBe(
      [
        "fields[0]=title",
        "fields[1]=slug",
        "populate[head]=true",
        "populate[teams][populate][lead]=true",
        "populate[author][fields][0]=displayName",
        "populate[author][fields][1]=jobTitle",
        "populate[manager][populate][avatar][fields][0]=url",
        "sort[0]=name:asc",
        "sort[1]=id:asc",
        "sort=pinned:desc,createdAt:desc",
        "pagination[page]=2",
        "pagination[pageSize]=100",
        "pagination[pageSize]=5",
        "window=30",
      ].join("&"),
    );
  });

  it.each([
    ["a key", () => strapiQuery().value("a&b", 1)],
    ["a filter path", () => strapiQuery().filter("slug]&x[", "$eq", 1)],
    ["a field name", () => strapiQuery().fields(["title&admin=1"])],
    ["a relation", () => strapiQuery().populate("author#")],
    ["a sort spec", () => strapiQuery().sort(["name asc"])],
    ["a literal value", () => strapiQuery().literal("days", "30%")],
    ["an encoded-looking part", () => strapiQuery().sortBy("id%3Aasc")],
    ["an empty part", () => strapiQuery().fields([""])],
  ])("refuses an unsafe structure part: %s", (_, build) => {
    expect(build).toThrow(/not a structure part/);
  });

  it("appends another query's parts in order", () => {
    const filter = strapiQuery().filter("a", "$eq", "1");
    expect(strapiQuery().append(filter).pageSize(1).toString()).toBe(
      "filters[a][$eq]=1&pagination[pageSize]=1",
    );
  });
});

describe("withQuery", () => {
  it("joins path and query, and leaves out an empty query", () => {
    expect(withQuery("/api/polls", strapiQuery().pageSize(20))).toBe(
      "/api/polls?pagination[pageSize]=20",
    );
    expect(withQuery("/api/me", strapiQuery())).toBe("/api/me");
  });
});
