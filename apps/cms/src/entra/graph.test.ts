import { describe, expect, it, vi } from "vitest";
import {
  GRAPH_CHECK_MEMBER_GROUPS_URL,
  GRAPH_MANAGER_URL,
  GRAPH_ME_URL,
  GRAPH_TIMEOUT_MS,
  checkMemberGroups,
  describeGraphResult,
  fetchGraphMe,
  fetchManagerOid,
  type GraphOptions,
} from "./graph";

/**
 * D-ENTRA-01 spec G: every Graph call has a typed result for every answer,
 * 3 s timeouts, no retry, and the token only in the Authorization header.
 * Fake ids and a fake token only.
 */
const TOKEN = "graph-access-token-SECRET-value";
const OID = "0f0f0f0f-1e1e-4d2d-8c3c-4b4b4b4b4b4b";
const MANAGER = "5a5a5a5a-6b6b-4c7c-8d8d-9e9e9e9e9e9e";
const G1 = "00000000-0000-4000-8000-000000000001";
const G2 = "00000000-0000-4000-8000-000000000002";

type Answer = () => Promise<Response>;

/** A fetch stub that records each call and answers with `answer`. */
function stubFetch(answer: Answer) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return answer();
  });
  return { calls, options: { fetch: fetchImpl as unknown as typeof fetch } satisfies GraphOptions };
}

const me = {
  id: OID.toUpperCase(),
  displayName: "Ada Lovelace",
  mail: "Ada@Example.test",
  userPrincipalName: "ada@example.test",
  jobTitle: "Engineer",
  department: "IT Engineering",
  officeLocation: "Room 1",
  businessPhones: ["+49 30 1234", 7],
  userType: "Member",
};

/** The failure answers every call must type, with the reason it gives. */
const FAILURES: [string, Answer, string | number][] = [
  ["403", async () => new Response("{}", { status: 403 }), 403],
  ["429", async () => new Response("{}", { status: 429, headers: { "retry-after": "1" } }), 429],
  ["500", async () => new Response("oops", { status: 500 }), 500],
  [
    "a timeout",
    async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
    "timeout",
  ],
  [
    "a network error",
    async () => {
      throw new TypeError("fetch failed");
    },
    "network",
  ],
  ["a non-JSON body", async () => new Response("<html>", { status: 200 }), "malformed"],
];

describe("fetchGraphMe", () => {
  it("GETs /me with the exchange's $select and the bearer token, once", async () => {
    const { calls, options } = stubFetch(async () => Response.json(me));
    const result = await fetchGraphMe(TOKEN, options);
    expect(result).toEqual({
      ok: true,
      data: {
        id: OID,
        displayName: "Ada Lovelace",
        mail: "Ada@Example.test",
        userPrincipalName: "ada@example.test",
        jobTitle: "Engineer",
        department: "IT Engineering",
        officeLocation: "Room 1",
        businessPhones: ["+49 30 1234"],
        userType: "Member",
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(GRAPH_ME_URL);
    expect(calls[0].url).toContain(
      "$select=id,displayName,mail,userPrincipalName,jobTitle,department,officeLocation,businessPhones,userType",
    );
    expect(calls[0].url).not.toContain(TOKEN);
    expect(calls[0].init.method).toBe("GET");
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("types null and missing fields as null", async () => {
    const { options } = stubFetch(async () => Response.json({ id: OID, jobTitle: null }));
    expect(await fetchGraphMe(TOKEN, options)).toMatchObject({
      ok: true,
      data: { jobTitle: null, mail: null, businessPhones: [], userType: null },
    });
  });

  it.each(FAILURES)("types %s without retrying", async (_name, answer, reason) => {
    const { calls, options } = stubFetch(answer);
    expect(await fetchGraphMe(TOKEN, options)).toEqual({ ok: false, reason });
    expect(calls).toHaveLength(1);
  });

  it("calls a body without a GUID id malformed", async () => {
    for (const body of [{}, { id: 7 }, { id: "someone" }, [me]]) {
      const { options } = stubFetch(async () => Response.json(body));
      expect(await fetchGraphMe(TOKEN, options)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("aborts a hanging call at its timeout (3 s by default)", async () => {
    expect(GRAPH_TIMEOUT_MS).toBe(3000);
    // A fetch that only settles when its signal aborts, like undici's.
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const started = Date.now();
    const result = await fetchGraphMe(TOKEN, {
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 50,
    });
    expect(result).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("checkMemberGroups", () => {
  it("POSTs the group ids and returns the member subset lower-cased", async () => {
    const { calls, options } = stubFetch(async () => Response.json({ value: [G2.toUpperCase()] }));
    expect(await checkMemberGroups(TOKEN, [G1, G2], options)).toEqual({ ok: true, data: [G2] });
    expect(calls[0].url).toBe(GRAPH_CHECK_MEMBER_GROUPS_URL);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ groupIds: [G1, G2] });
    expect(String(calls[0].init.body)).not.toContain(TOKEN);
  });

  it("accepts an empty answer (member of none)", async () => {
    const { options } = stubFetch(async () => Response.json({ value: [] }));
    expect(await checkMemberGroups(TOKEN, [G1], options)).toEqual({ ok: true, data: [] });
  });

  it.each(FAILURES)("types %s", async (_name, answer, reason) => {
    const { options } = stubFetch(answer);
    expect(await checkMemberGroups(TOKEN, [G1], options)).toEqual({ ok: false, reason });
  });

  it("calls a non-array or ids outside the input malformed", async () => {
    for (const body of [{}, { value: G1 }, { value: [G1, 3] }, { value: [G2] }, [G1]]) {
      const { options } = stubFetch(async () => Response.json(body));
      expect(await checkMemberGroups(TOKEN, [G1], options), JSON.stringify(body)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });
});

describe("fetchManagerOid", () => {
  it("returns the manager's oid on 200", async () => {
    const { calls, options } = stubFetch(async () => Response.json({ id: MANAGER.toUpperCase() }));
    expect(await fetchManagerOid(TOKEN, options)).toEqual({ ok: true, data: MANAGER });
    expect(calls[0].url).toBe(GRAPH_MANAGER_URL);
  });

  it("returns null (no manager) on 404", async () => {
    const { options } = stubFetch(async () => new Response("{}", { status: 404 }));
    expect(await fetchManagerOid(TOKEN, options)).toEqual({ ok: true, data: null });
  });

  it.each(FAILURES)("types %s as unknown", async (_name, answer, reason) => {
    const { options } = stubFetch(answer);
    expect(await fetchManagerOid(TOKEN, options)).toEqual({ ok: false, reason });
  });

  it("calls a body without a GUID id malformed", async () => {
    const { options } = stubFetch(async () => Response.json({ displayName: "Boss" }));
    expect(await fetchManagerOid(TOKEN, options)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("describeGraphResult", () => {
  it("names each result for the audit line, never the data", () => {
    expect(describeGraphResult(null)).toBe("off");
    expect(describeGraphResult({ ok: true, data: { secret: TOKEN } })).toBe("ok");
    expect(describeGraphResult({ ok: false, reason: 403 })).toBe("403");
    expect(describeGraphResult({ ok: false, reason: "timeout" })).toBe("timeout");
  });
});
