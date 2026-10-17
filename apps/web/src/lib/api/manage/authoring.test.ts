import { beforeEach, describe, expect, it, vi } from "vitest";
import { AUTHORING_INTENTS, AUTHORING_TYPES, authoringRoute } from "@sinnlos/domain";

/**
 * The authoring transport against the frozen K7 route table (decision 06
 * §B3): each intent's path and method come from @sinnlos/domain, the
 * explicit types carry ?status=, polls never do, every mutation but create
 * carries If-Match with the version in double quotes, and the list query
 * keeps only status, q (capped), page and owner. strapi() is mocked.
 */
const strapiMock = vi.fn();
vi.mock("@/lib/strapi/client", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));

const { fetchAuthoringList, fetchEditable, sendAuthoringWrite } = await import("./authoring");

const DOC = "annc00000000000000000001";

beforeEach(() => {
  strapiMock.mockReset().mockResolvedValue({ data: {} });
});

describe("sendAuthoringWrite", () => {
  it.each(
    AUTHORING_TYPES.flatMap((type) =>
      AUTHORING_INTENTS[type]
        .filter((intent) => intent !== "authoringList" && intent !== "editable")
        .map((intent) => [type, intent] as const),
    ),
  )("%s %s follows the route table", async (type, intent) => {
    const route = authoringRoute(type, intent as Parameters<typeof authoringRoute>[1]);
    const writeIntent = intent as Parameters<typeof sendAuthoringWrite>[1];
    await sendAuthoringWrite(type, writeIntent, {
      documentId: DOC,
      version: "12",
      status: "draft",
      data: { a: 1 },
    });
    const [path, init] = strapiMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body?: string },
    ];
    const explicit = type !== "poll" && (intent === "create" || intent === "update");
    expect(path).toBe(
      `/api${route.path.replace(":documentId", DOC)}${explicit ? "?status=draft" : ""}`,
    );
    expect(init.method).toBe(route.method);
    expect(init.headers).toEqual(route.ifMatch ? { "If-Match": '"12"' } : {});
    if (intent === "create" || intent === "update") {
      expect(JSON.parse(init.body ?? "")).toEqual({ data: { a: 1 } });
    } else {
      expect(init.body).toBeUndefined();
    }
  });

  it("refuses to send an explicit type's create without a status, or a mutation without a version", () => {
    expect(() => sendAuthoringWrite("announcement", "create", { data: {} })).toThrow(/status/);
    expect(() => sendAuthoringWrite("event", "publish", { documentId: DOC })).toThrow(/version/);
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("encodes the documentId into the path", async () => {
    await sendAuthoringWrite("event", "delete", { documentId: "a/b?c", version: "1" });
    expect(strapiMock.mock.calls[0][0]).toBe("/api/events/a%2Fb%3Fc");
  });
});

describe("fetchAuthoringList and fetchEditable", () => {
  it("sends only the filters that are set", async () => {
    await fetchAuthoringList("announcement");
    expect(strapiMock.mock.calls[0][0]).toBe("/api/announcements/authoring");
    await fetchAuthoringList("quickLink", {
      status: "scheduled",
      q: "  hr & it ",
      page: 3,
      owner: "department",
    });
    expect(strapiMock.mock.calls[1][0]).toBe(
      "/api/quick-links/authoring?status=scheduled&q=hr%20%26%20it&page=3&owner=department",
    );
  });

  it("caps q at 100 characters and leaves out page 1", async () => {
    await fetchAuthoringList("event", { q: "x".repeat(150), page: 1 });
    expect(strapiMock.mock.calls[0][0]).toBe(`/api/events/authoring?q=${"x".repeat(100)}`);
  });

  it("reads the form from /editable", async () => {
    await fetchEditable("poll", DOC);
    expect(strapiMock.mock.calls[0]).toEqual([`/api/polls/${DOC}/editable`]);
  });
});

describe("training shares the guarded authoring transport", () => {
  it.each(["course", "lesson"] as const)(
    "%s sends explicit status and revision, and never delete",
    async (type) => {
      await sendAuthoringWrite(type, "update", {
        documentId: DOC,
        version: "4",
        status: "draft",
        data: { title: "Changed" },
      });
      expect(strapiMock).toHaveBeenCalledWith(
        `/api/${type}s/${DOC}?status=draft`,
        expect.objectContaining({ method: "PUT", headers: { "If-Match": '\"4\"' } }),
      );
      expect(() => sendAuthoringWrite(type, "create", { data: {} })).toThrow(/status/);
      expect(() => sendAuthoringWrite(type, "delete", { documentId: DOC, version: "4" })).toThrow(
        /delete/,
      );
    },
  );
  it("filters lessons by course on the server and omits training owner overrides", async () => {
    await fetchAuthoringList("lesson", { course: DOC, page: 2, owner: "moderators" });
    expect(strapiMock).toHaveBeenCalledWith(`/api/lessons/authoring?page=2&course=${DOC}`);
  });
});
