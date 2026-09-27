import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The web's ICS proxy (EVT-ICS-ID). Pinned:
 *   1. `[id]` is checked with the cms's own rules (lib/entry-id.ts, mirrored)
 *      BEFORE the session is read or the cms is called: a documentId or a
 *      numeric row id passes, anything else is a 404,
 *   2. the id is forwarded URL-encoded, with the caller's Strapi JWT and
 *      cache: "no-store" (D-DC01),
 *   3. no JWT is a 401, a cms error keeps its status, and the file comes
 *      back with the cms's Content-Disposition (or a fallback name).
 *
 * `@/lib/session` is mocked (the real module pulls in next-auth), as are
 * `@/lib/config` and global fetch.
 */
const getStrapiTokenMock = vi.fn<() => Promise<string | null>>();
const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();

vi.mock("@/lib/session", () => ({ getStrapiToken: () => getStrapiTokenMock() }));
vi.mock("@/lib/config", () => ({ STRAPI_URL: "http://cms.test" }));
vi.stubGlobal("fetch", fetchMock);

const { GET } = await import("./route");

const DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";
const ICS = "BEGIN:VCALENDAR\r\nEND:VCALENDAR";

function get(id: string) {
  return GET(new NextRequest(`http://web.test/events/${encodeURIComponent(id)}/ics`), {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  getStrapiTokenMock.mockReset();
  getStrapiTokenMock.mockResolvedValue("jwt-1");
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(ICS, {
      status: 200,
      headers: { "Content-Disposition": 'attachment; filename="Summer party.ics"' },
    }),
  );
});

describe("GET /events/[id]/ics", () => {
  it("forwards a documentId with the caller's JWT, uncached", async () => {
    const res = await get(DOC);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ICS);
    expect(res.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="Summer party.ics"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://cms.test/api/events/${DOC}/ics`);
    expect(init.headers).toEqual({ Authorization: "Bearer jwt-1" });
    expect(init.cache).toBe("no-store");
  });

  it("still forwards a numeric row id (links from before 2026-09-27)", async () => {
    const res = await get("42");
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toBe("http://cms.test/api/events/42/ics");
  });

  it("answers any other id with 404, before the session or the cms", async () => {
    for (const id of [
      "",
      "abc",
      "doc-1",
      "demo-event-1",
      "0",
      "01",
      "-1",
      "1.5",
      "1e3",
      "2147483648",
      "99999999999999999999",
      DOC.toUpperCase(),
      `${DOC}x`,
      "..",
      "../users/me",
      "1/../../users",
      "1?x=1",
      "1#x",
      "%2e%2e",
    ]) {
      const res = await get(id);
      expect(res.status, JSON.stringify(id)).toBe(404);
      expect(await res.text()).toBe("Event not found");
    }
    expect(getStrapiTokenMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 401 without a Strapi JWT", async () => {
    getStrapiTokenMock.mockResolvedValue(null);
    const res = await get(DOC);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a cms error status through", async () => {
    fetchMock.mockResolvedValue(new Response("Not Found", { status: 404 }));
    const res = await get(DOC);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Event not found");
  });

  it("names the file after the id when the cms sends no Content-Disposition", async () => {
    fetchMock.mockResolvedValue(new Response(ICS, { status: 200 }));
    const res = await get(DOC);
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="event-${DOC}.ics"`);
  });
});
