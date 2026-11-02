import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StrapiError } from "@/lib/strapi-error";

/**
 * The secret-share Server Actions (v0.35, plan §3.10):
 *   - each sends exactly the contract's request (the cms refuses unknown
 *     keys and any body on reveal and revoke) after the same local checks;
 *   - a refusal maps by status AND details.code to its refusal
 *     (`unavailable` has three: 409, 503, 410), anything else to the
 *     common codes;
 *   - a failure logs one line with the status and the code only: never the
 *     upstream body, never a malformed answer's text (the sentinel);
 *   - the reveal never refreshes (the text must not reach a page tree);
 *     revoke does;
 *   - strapi()'s sign-in redirect propagates.
 */

const strapiMock = vi.fn();
const refreshMock = vi.fn();

vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("next/cache", () => ({ refresh: () => refreshMock() }));

const { createSecret, findSecretRecipients, revealSecret, revokeSecret } =
  await import("./secret-actions");
const { settleSecretCall } = await import("./secret-share-errors");

const ID = "abcdefghijklmnopqrstuvwx";
const SENTINEL = "sentinel-7f3a-do-not-log";

const refusal = (status: number, code?: string) =>
  new StrapiError(
    status,
    "x",
    JSON.stringify({
      data: null,
      error: { status, name: "X", message: SENTINEL, details: code ? { code } : {} },
    }),
  );

function signInRedirect(): unknown {
  try {
    redirect("/sign-in?expired=1");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

let logged: string[] = [];

beforeEach(() => {
  strapiMock.mockReset();
  refreshMock.mockReset();
  logged = [];
  const capture = (...args: unknown[]) => {
    logged.push(
      args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "),
    );
  };
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  vi.spyOn(console, "log").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSecret", () => {
  it("posts exactly recipient, text and lifetime, and answers the new id", async () => {
    strapiMock.mockResolvedValue({ data: { id: ID, expiresAt: "2026-11-02T10:00:00.000Z" } });
    await expect(createSecret(7, " pass word ", "24h")).resolves.toEqual({
      ok: true,
      data: { id: ID },
    });
    const [path, init] = strapiMock.mock.calls[0] as [string, { method: string; body: string }];
    expect(path).toBe("/api/secret-shares");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      data: { recipient: 7, text: " pass word ", lifetime: "24h" },
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("refuses a bad recipient, text or lifetime before any request", async () => {
    await expect(createSecret(0, "x", "1h")).resolves.toEqual({ ok: false, code: "recipient" });
    await expect(createSecret(7, "   ", "1h")).resolves.toEqual({ ok: false, code: "text" });
    await expect(createSecret(7, "x".repeat(8193), "1h")).resolves.toEqual({
      ok: false,
      code: "text",
    });
    await expect(createSecret(7, "x", "7d" as "1h")).resolves.toEqual({
      ok: false,
      code: "lifetime",
    });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("answers busy as its own code: the outcome is unknown", async () => {
    strapiMock.mockRejectedValue(refusal(503, "busy"));
    await expect(createSecret(7, "x", "1h")).resolves.toEqual({ ok: false, code: "busy" });
    expect(logged).toEqual(["[secrets] create failed: 503 → busy"]);
  });
});

describe("revealSecret", () => {
  it("posts without a body, answers the text and never refreshes", async () => {
    strapiMock.mockResolvedValue({ data: { text: SENTINEL } });
    await expect(revealSecret(ID)).resolves.toEqual({ ok: true, data: { text: SENTINEL } });
    expect(strapiMock).toHaveBeenCalledWith(`/api/secret-shares/${ID}/reveal`, { method: "POST" });
    expect(refreshMock).not.toHaveBeenCalled();
    expect(logged).toEqual([]);
  });

  it("maps each refusal by status and code", async () => {
    const cases: [StrapiError | Error, string][] = [
      [refusal(410, "gone"), "gone"],
      [refusal(409, "unavailable"), "partyIneligible"],
      [refusal(503, "unavailable"), "noKey"],
      [refusal(410, "unavailable"), "cancelled"],
      [refusal(503, "busy"), "busy"],
      [refusal(429, "quota"), "quota"],
      [refusal(404), "notFound"],
      [refusal(400), "invalid"],
      [refusal(403), "forbidden"],
      [refusal(429), "unavailable"],
    ];
    for (const [error, code] of cases) {
      strapiMock.mockRejectedValueOnce(error);
      await expect(revealSecret(ID), code).resolves.toEqual({ ok: false, code });
    }
  });

  it("logs no upstream body and no malformed answer, only the status and the code", async () => {
    strapiMock.mockRejectedValueOnce(refusal(500));
    strapiMock.mockRejectedValueOnce(new SyntaxError(`Unexpected token in JSON: ${SENTINEL}`));
    strapiMock.mockResolvedValueOnce({ data: { secret: SENTINEL } });
    await revealSecret(ID);
    await revealSecret(ID);
    await revealSecret(ID);
    expect(logged).toEqual([
      "[secrets] reveal failed: 500 → busy",
      "[secrets] reveal failed: - → busy",
      "[secrets] reveal failed: - → busy",
    ]);
    expect(logged.join("\n")).not.toContain(SENTINEL);
  });

  it("refuses a malformed id without a request, and lets the sign-in redirect through", async () => {
    await expect(revealSecret("../x")).resolves.toEqual({ ok: false, code: "notFound" });
    expect(strapiMock).not.toHaveBeenCalled();
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValue(redirectError);
    await expect(revealSecret(ID)).rejects.toBe(redirectError);
  });
});

/** A cms answer that may follow a committed write, so its outcome is unknown. */
const lostAnswers = (): [string, () => void][] => [
  ["a network error", () => strapiMock.mockRejectedValueOnce(new TypeError("fetch failed"))],
  [
    "a timeout",
    () => strapiMock.mockRejectedValueOnce(Object.assign(new Error("t"), { name: "TimeoutError" })),
  ],
  ["a 5xx without a code", () => strapiMock.mockRejectedValueOnce(refusal(502))],
  ["a malformed success", () => strapiMock.mockResolvedValueOnce({ data: null })],
];

describe("a lost answer to a write is an unknown outcome (busy), never 'try again'", () => {
  it.each(lostAnswers())("create and reveal after %s", async (_what, lose) => {
    lose();
    await expect(createSecret(7, "x", "1h")).resolves.toEqual({ ok: false, code: "busy" });
    lose();
    await expect(revealSecret(ID)).resolves.toEqual({ ok: false, code: "busy" });
  });

  // revoke takes any success body: only its failures can lose an answer.
  it.each(lostAnswers().slice(0, 3))("revoke after %s", async (_what, lose) => {
    lose();
    await expect(revokeSecret(ID)).resolves.toEqual({ ok: false, code: "busy" });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("keeps the search's plain codes: it changes nothing", async () => {
    strapiMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(findSecretRecipients("a")).resolves.toEqual({ ok: false, code: "unavailable" });
    strapiMock.mockRejectedValueOnce(refusal(500));
    await expect(findSecretRecipients("a")).resolves.toEqual({ ok: false, code: "unavailable" });
  });
});

describe("settleSecretCall: the browser's call of a write", () => {
  it("answers busy when the call itself fails, passes results and the sign-in redirect", async () => {
    await expect(
      settleSecretCall(Promise.reject(new TypeError("Failed to fetch"))),
    ).resolves.toEqual({ ok: false, code: "busy" });
    await expect(settleSecretCall(Promise.resolve({ ok: false, code: "gone" }))).resolves.toEqual({
      ok: false,
      code: "gone",
    });
    const redirectError = signInRedirect();
    await expect(settleSecretCall(Promise.reject(redirectError))).rejects.toBe(redirectError);
  });
});

describe("revokeSecret", () => {
  it("posts without a body and refreshes on success only", async () => {
    strapiMock.mockResolvedValueOnce({ data: { id: ID } });
    await expect(revokeSecret(ID)).resolves.toEqual({ ok: true });
    expect(strapiMock).toHaveBeenCalledWith(`/api/secret-shares/${ID}/revoke`, { method: "POST" });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    strapiMock.mockRejectedValueOnce(refusal(410, "gone"));
    await expect(revokeSecret(ID)).resolves.toEqual({ ok: false, code: "gone" });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });
});

describe("findSecretRecipients", () => {
  it("asks with q only, encoded, and refuses an over-long q", async () => {
    strapiMock.mockResolvedValue({ data: [{ id: 3, displayName: "Ada", department: null }] });
    await expect(findSecretRecipients("a&b c")).resolves.toEqual({
      ok: true,
      data: [{ id: 3, displayName: "Ada", department: null }],
    });
    expect(strapiMock).toHaveBeenCalledWith("/api/secret-shares/recipients?q=a%26b%20c");
    await expect(findSecretRecipients("x".repeat(101))).resolves.toEqual({
      ok: false,
      code: "invalid",
    });
    expect(strapiMock).toHaveBeenCalledTimes(1);
  });
});
