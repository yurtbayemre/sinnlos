import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  actionFailure,
  commonCmsFailure,
  failureFor,
  isSharedErrorCode,
  runCmsAction,
  startCmsAction,
  type ActionResult,
  type CmsErrorInfo,
} from "./action-result";
import { StrapiError } from "./strapi-error";

/**
 * The ActionResult contract (AC01, decision 06 §L3): the common mapping by
 * status, `fields` from details.keys/codes, `version` from details.current,
 * an action's own mapError first, network errors as "unavailable", Next's
 * control flow (strapi()'s sign-in redirect) never a result, and the client
 * helper's order of steps. next/navigation is the real module, so the
 * redirect is a genuine NEXT_REDIRECT and unstable_rethrow the real check.
 */

const info = (status: number, details: CmsErrorInfo["details"] = null): CmsErrorInfo => ({
  status,
  name: null,
  message: null,
  details,
});

const cmsError = (status: number, error: Record<string, unknown> = {}) =>
  new StrapiError(status, "Error", JSON.stringify({ data: null, error: { status, ...error } }));

function signInRedirect(): unknown {
  try {
    redirect("/sign-in?expired=1");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  error = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("commonCmsFailure", () => {
  it.each([
    [400, "invalid"],
    [401, "forbidden"],
    [403, "forbidden"],
    [404, "notFound"],
    [405, "failed"],
    [409, "failed"],
    [412, "conflict"],
    [413, "failed"],
    [428, "failed"],
    [429, "unavailable"],
    [500, "unavailable"],
    [502, "unavailable"],
    [503, "unavailable"],
  ])("maps %i to %s", (status, code) => {
    expect(commonCmsFailure(info(status))).toEqual({ ok: false, code });
  });

  it("gives a 400 the named fields: a listed key without a code is 'invalid'", () => {
    expect(
      commonCmsFailure(
        info(400, { keys: ["title", "startsAt"], codes: { startsAt: "invalidInstant" } }),
      ),
    ).toEqual({
      ok: false,
      code: "invalid",
      fields: { title: "invalid", startsAt: "invalidInstant" },
    });
  });

  it("keeps a code whose key is not listed (a _form code, decision 06 §B5)", () => {
    expect(commonCmsFailure(info(400, { codes: { _form: "spaceNotEmpty" } }))).toEqual({
      ok: false,
      code: "invalid",
      fields: { _form: "spaceNotEmpty" },
    });
  });

  it("ignores malformed keys and codes", () => {
    expect(commonCmsFailure(info(400, { keys: "title", codes: ["x"] }))).toEqual({
      ok: false,
      code: "invalid",
    });
    expect(
      commonCmsFailure(info(400, { keys: [7, "", "title"], codes: { title: 3, "": "x" } })),
    ).toEqual({ ok: false, code: "invalid", fields: { title: "invalid" } });
    expect(commonCmsFailure(info(400, {}))).toEqual({ ok: false, code: "invalid" });
  });

  it("carries the CMS's current revision with a 412", () => {
    expect(commonCmsFailure(info(412, { current: "17" }))).toEqual({
      ok: false,
      code: "conflict",
      version: "17",
    });
    expect(commonCmsFailure(info(412, { current: 18 }))).toEqual({
      ok: false,
      code: "conflict",
      version: "18",
    });
    expect(commonCmsFailure(info(412, { current: "" }))).toEqual({
      ok: false,
      code: "conflict",
    });
  });
});

describe("failureFor", () => {
  it("asks the action's mapError first and falls through on undefined", () => {
    const mapError = vi.fn((cms: CmsErrorInfo) =>
      cms.status === 400 && cms.message === "Event is at capacity" ? ("full" as const) : undefined,
    );
    expect(
      failureFor(
        cmsError(400, { name: "BadRequestError", message: "Event is at capacity" }),
        mapError,
      ),
    ).toEqual({ ok: false, code: "full" });
    expect(mapError).toHaveBeenLastCalledWith({
      status: 400,
      name: "BadRequestError",
      message: "Event is at capacity",
      details: null,
    });
    expect(failureFor(cmsError(400, { message: "Invalid status" }), mapError)).toEqual({
      ok: false,
      code: "invalid",
    });
  });

  it.each([
    ["fetch's network failure", new TypeError("fetch failed")],
    ["a timeout", Object.assign(new Error("timed out"), { name: "TimeoutError" })],
    ["an abort", Object.assign(new Error("aborted"), { name: "AbortError" })],
  ])("maps %s to unavailable", (_label, cause) => {
    expect(failureFor(cause)).toEqual({ ok: false, code: "unavailable" });
  });

  it.each([
    ["a plain error", new Error("boom")],
    ["an unparsable answer", new SyntaxError("Unexpected token <")],
    ["a non-error rejection", "boom"],
  ])("maps %s to failed", (_label, cause) => {
    expect(failureFor(cause)).toEqual({ ok: false, code: "failed" });
  });
});

describe("runCmsAction", () => {
  it("answers ok after `after`, with the data taken from the answer", async () => {
    const after = vi.fn();
    const result = await runCmsAction(async () => ({ data: { id: 3 } }), {
      label: "[test] save",
      after,
      data: (value) => value.data.id,
    });
    expect(result).toEqual({ ok: true, data: 3 });
    expect(after).toHaveBeenCalledWith({ data: { id: 3 } });
  });

  it("answers ok without data when no mapper is given", async () => {
    await expect(runCmsAction(async () => undefined, { label: "[test]" })).resolves.toEqual({
      ok: true,
    });
  });

  it("maps a refusal, logs one warning and skips `after`", async () => {
    const after = vi.fn();
    const result = await runCmsAction<"full">(
      async () => {
        throw cmsError(400, { name: "BadRequestError", message: "Event is at capacity" });
      },
      {
        label: "[events] rsvp",
        after,
        mapError: (cms) => (cms.message === "Event is at capacity" ? "full" : undefined),
      },
    );
    expect(result).toEqual({ ok: false, code: "full" });
    expect(after).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("[events] rsvp refused: 400 BadRequestError → full");
    expect(error).not.toHaveBeenCalled();
  });

  it("logs outages, a missing If-Match (428) and bugs as errors", async () => {
    for (const cause of [cmsError(503), cmsError(428), new TypeError("fetch failed")]) {
      await runCmsAction(
        async () => {
          throw cause;
        },
        { label: "[test]" },
      );
    }
    expect(error).toHaveBeenCalledTimes(3);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rethrows strapi()'s sign-in redirect instead of answering", async () => {
    const redirectError = signInRedirect();
    const after = vi.fn();
    await expect(
      runCmsAction(
        async () => {
          throw redirectError;
        },
        { label: "[test]", after },
      ),
    ).rejects.toBe(redirectError);
    expect(after).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe("startCmsAction", () => {
  /** startTransition stand-in: runs the callback, keeps its promise. */
  function transitions() {
    const started: Promise<void>[] = [];
    return {
      start: (callback: () => Promise<void>) => void started.push(callback()),
      settled: () => Promise.allSettled(started),
      started,
    };
  }

  it("applies the optimistic update first, then answers onSuccess", async () => {
    const order: string[] = [];
    const t = transitions();
    startCmsAction(t.start, {
      optimistic: () => order.push("optimistic"),
      action: async () => {
        order.push("action");
        return { ok: true, data: 1 } as ActionResult<never, number>;
      },
      onSuccess: (data) => void order.push(`success:${data}`),
      onFailure: () => void order.push("failure"),
      onSettled: () => void order.push("settled"),
    });
    await t.settled();
    expect(order).toEqual(["optimistic", "action", "success:1", "settled"]);
  });

  it("hands a failure's code to onFailure", async () => {
    const t = transitions();
    const onFailure = vi.fn();
    const onSuccess = vi.fn();
    startCmsAction<"pollOptionsChanged", undefined>(t.start, {
      action: async () => actionFailure("pollOptionsChanged"),
      onSuccess,
      onFailure,
    });
    await t.settled();
    expect(onFailure).toHaveBeenCalledWith("pollOptionsChanged");
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("reports a rejected call (web server unreachable) and a failed refetch as unavailable", async () => {
    const t = transitions();
    const onFailure = vi.fn();
    const onSettled = vi.fn();
    startCmsAction(t.start, {
      action: () => Promise.reject(new TypeError("Failed to fetch")),
      onFailure,
      onSettled,
    });
    startCmsAction(t.start, {
      action: async () => ({ ok: true }),
      onSuccess: () => Promise.reject(new Error("refetch failed")),
      onFailure,
      onSettled,
    });
    await t.settled();
    expect(onFailure.mock.calls).toEqual([["unavailable"], ["unavailable"]]);
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("rethrows the sign-in redirect so Next navigates", async () => {
    const t = transitions();
    const redirectError = signInRedirect();
    const onFailure = vi.fn();
    startCmsAction(t.start, { action: () => Promise.reject(redirectError), onFailure });
    await expect(t.started[0]).rejects.toBe(redirectError);
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe("isSharedErrorCode", () => {
  it("names the codes with one shared text", () => {
    for (const code of ["forbidden", "notFound", "conflict", "unavailable"]) {
      expect(isSharedErrorCode(code), code).toBe(true);
    }
    for (const code of ["invalid", "failed", "full", "pollOptionsChanged", ""]) {
      expect(isSharedErrorCode(code), code).toBe(false);
    }
  });
});
