import { afterEach, describe, expect, it, vi } from "vitest";
import { SECRET_CREATES_PER_MINUTE, SECRET_TEXT_MAX_BYTES } from "@sinnlos/domain";
import { errors } from "@strapi/utils";

import { Refusal } from "./refusal";
import {
  LIMITER_MAX_SENDERS,
  __resetCreateLimiterForTest,
  confirmed,
  isEligible,
  parseCreate,
  refuseShare,
  reserveCreate,
  type SecretShareHost,
} from "./secret-shares";

/**
 * The pure parts of secret sharing (v0.35.0): input rules, the limiter, the
 * refusals and the commit confirmation. The locked transactions run against
 * the real cms on both engines in
 * integration/secret-shares.integration.test.ts.
 */

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof Refusal)
      return { status: err.status, code: (err.details as { code?: string } | undefined)?.code };
    throw err;
  }
  return null;
};

afterEach(() => __resetCreateLimiterForTest());

describe("parseCreate", () => {
  const ok = { recipient: 12, text: "hunter2", lifetime: "1h" };

  it("takes the body or Strapi's { data } envelope and keeps the text as sent", () => {
    expect(parseCreate(ok, 7)).toEqual(ok);
    expect(parseCreate({ data: { ...ok, text: " a b " } }, 7)).toEqual({ ...ok, text: " a b " });
  });

  it("refuses the recipient: missing, not a row id, or oneself", () => {
    for (const recipient of [undefined, null, "12", 0, -1, 1.5, 7]) {
      expect(
        refusal(() => parseCreate({ ...ok, recipient }, 7)),
        String(recipient),
      ).toEqual({
        status: 400,
        code: "recipient",
      });
    }
  });

  it("refuses the text: blank, too many UTF-8 bytes, a lone surrogate, not a string", () => {
    for (const text of ["", "  ", "ä".repeat(SECRET_TEXT_MAX_BYTES / 2 + 1), "a\ud800", 42]) {
      expect(refusal(() => parseCreate({ ...ok, text }, 7))).toEqual({ status: 400, code: "text" });
    }
    expect(
      parseCreate({ ...ok, text: "ä".repeat(SECRET_TEXT_MAX_BYTES / 2) }, 7).text,
    ).toHaveLength(SECRET_TEXT_MAX_BYTES / 2);
  });

  it("refuses any lifetime but 1h and 24h", () => {
    for (const lifetime of [undefined, "7d", "2h", 3600]) {
      expect(refusal(() => parseCreate({ ...ok, lifetime }, 7))).toEqual({
        status: 400,
        code: "lifetime",
      });
    }
    expect(parseCreate({ ...ok, lifetime: "24h" }, 7).lifetime).toBe("24h");
  });

  it("refuses unknown keys (no populate, fields or extra data)", () => {
    expect(() => parseCreate({ ...ok, populate: "*" }, 7)).toThrow(errors.ValidationError);
    expect(() => parseCreate({ data: { ...ok, senderId: 1 } }, 7)).toThrow(errors.ValidationError);
  });
});

describe("reserveCreate", () => {
  it("allows SECRET_CREATES_PER_MINUTE per sender and minute, every attempt counted", () => {
    const now = 1_000_000;
    for (let i = 0; i < SECRET_CREATES_PER_MINUTE; i++)
      expect(reserveCreate(7, now + i)).toBe(true);
    expect(reserveCreate(7, now + 100)).toBe(false);
    // Another sender has a minute of its own.
    expect(reserveCreate(8, now + 100)).toBe(true);
    // The window slides.
    expect(reserveCreate(7, now + 60_000)).toBe(true);
  });

  it("keeps at most LIMITER_MAX_SENDERS senders (bounded memory)", () => {
    for (let id = 1; id <= LIMITER_MAX_SENDERS + 5; id++) reserveCreate(id, 0);
    // The oldest senders were evicted, so they start a fresh minute.
    for (let i = 0; i < SECRET_CREATES_PER_MINUTE; i++) expect(reserveCreate(1, 1)).toBe(true);
  });
});

describe("refuseShare", () => {
  it("answers the frozen status and code of each cause", () => {
    expect(refusal(() => refuseShare("partyIneligible"))).toEqual({
      status: 409,
      code: "unavailable",
    });
    expect(refusal(() => refuseShare("noKey"))).toEqual({ status: 503, code: "unavailable" });
    expect(refusal(() => refuseShare("cancelled"))).toEqual({ status: 410, code: "unavailable" });
    expect(refusal(() => refuseShare("gone"))).toEqual({ status: 410, code: "gone" });
    expect(refusal(() => refuseShare("quota"))).toEqual({ status: 429, code: "quota" });
    expect(refusal(() => refuseShare("busy"))).toEqual({ status: 503, code: "busy" });
  });
});

describe("isEligible", () => {
  it("is an unblocked staff member", () => {
    expect(isEligible({ blocked: false, role: { type: "member" } })).toBe(true);
    expect(isEligible({ blocked: null, role: { type: "admin_role" } })).toBe(true);
    expect(isEligible({ blocked: true, role: { type: "member" } })).toBe(false);
    expect(isEligible({ blocked: false, role: { type: "guest" } })).toBe(false);
    expect(isEligible({ blocked: false, role: { type: "authenticated" } })).toBe(false);
    expect(isEligible(null)).toBe(false);
  });
});

describe("confirmed (commit confirmation)", () => {
  function host(execution: Promise<unknown> | undefined, inTransaction = false) {
    const warn = vi.fn();
    const trx = { raw: vi.fn(), executionPromise: execution };
    const strapi = {
      db: {
        inTransaction: () => inTransaction,
        transaction: async (callback: (scope: { trx: typeof trx }) => Promise<unknown>) =>
          callback({ trx }),
      },
      log: { warn },
    } as unknown as SecretShareHost;
    return { strapi, warn };
  }

  it("returns the work's result once the COMMIT is confirmed", async () => {
    const { strapi } = host(Promise.resolve());
    await expect(confirmed(strapi, "reveal", async () => "text")).resolves.toBe("text");
  });

  it("answers busy, without the result, when the COMMIT failed or is unknown", async () => {
    for (const execution of [Promise.reject(new Error("COMMIT failed")), undefined]) {
      execution?.catch(() => undefined);
      const { strapi, warn } = host(execution);
      const err = await confirmed(strapi, "reveal", async () => "text").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Refusal);
      expect((err as Refusal).details).toEqual({ code: "busy" });
      expect(String(warn.mock.calls[0][0])).toMatch(
        /^\[secrets\] reveal answered busy: commit unconfirmed/,
      );
      expect(String(warn.mock.calls[0][0])).not.toContain("text");
    }
  });

  it("passes a refusal through and turns any other failure into busy, logging its code only", async () => {
    const { strapi, warn } = host(Promise.resolve());
    await expect(
      confirmed(strapi, "revoke", async () => {
        throw new errors.NotFoundError("Not Found");
      }),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    const deadlock = Object.assign(
      new Error('update "secret_shares" set "envelope" = $1 - deadlock'),
      {
        code: "40P01",
      },
    );
    const err = await confirmed(strapi, "revoke", async () => {
      throw deadlock;
    }).catch((e: unknown) => e);
    expect((err as Refusal).status).toBe(503);
    expect(warn).toHaveBeenCalledWith("[secrets] revoke answered busy: 40P01");
  });

  it("refuses to run inside another transaction (its COMMIT would not be its own)", async () => {
    const { strapi } = host(Promise.resolve(), true);
    await expect(confirmed(strapi, "create", async () => 1)).rejects.toThrow(/must not run inside/);
  });
});
