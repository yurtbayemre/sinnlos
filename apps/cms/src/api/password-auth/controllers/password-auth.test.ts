/**
 * forgot's detached half under a stalled mail transport (Codex review): a
 * reset slot is held until the transport settles, not only until the mail
 * timeout, so the sends in flight never exceed MAX_RESET_JOBS.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAIL_TIMEOUT_MS } from "../../../utils/account-mail";
import controller, { INTERNAL_TOKEN_HEADER, MAX_RESET_JOBS } from "./password-auth";

vi.mock("../../../utils/mfa-core", () => ({ lockUserRow: vi.fn(async () => undefined) }));
vi.mock("../../../utils/password-link", () => ({
  LINK_SELECT: [],
  isLocalUnbound: () => true,
  issueLink: vi.fn(async () => "7.token"),
  redeemLink: vi.fn(),
}));

const TOKEN = "internal-token-0123456789";
const releases: Array<() => void> = [];
let outstanding = 0;
let peak = 0;
// A blocked provider: a send settles only when the test releases it.
const send = vi.fn(
  () =>
    new Promise<void>((resolve) => {
      peak = Math.max(peak, ++outstanding);
      releases.push(() => {
        outstanding--;
        resolve();
      });
    }),
);

afterEach(() => {
  for (const release of releases.splice(0)) release();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function forgot(): Promise<void> {
  const res = new EventEmitter();
  const ctx = {
    get: (field: string) => (field === INTERNAL_TOKEN_HEADER ? TOKEN : ""),
    request: { body: { email: "anna@example.com" } },
    res,
    status: 0,
    body: null,
    notFound: vi.fn(),
  };
  await controller.forgot(ctx as never);
  expect(ctx.status).toBe(202);
  res.emit("finish");
}

describe("forgot under a stalled mail transport", () => {
  it("keeps each slot until the send settles: never more than MAX_RESET_JOBS sends in flight", async () => {
    for (const [key, value] of Object.entries({
      INTERNAL_UPLOAD_TOKEN: TOKEN,
      SMTP_HOST: "smtp.example.invalid",
      SMTP_USER: "u",
      SMTP_PASS: "p",
      DIGEST_FROM: "Intranet <noreply@example.com>",
      PUBLIC_WEB_URL: "https://intranet.example.com",
      ENTRA_ENABLED: "0",
      OIDC_ENABLED: "0",
    }))
      vi.stubEnv(key, value);
    const user = { id: 7, email: "anna@example.com", password: "$2a$10$x", blocked: false };
    vi.stubGlobal("strapi", {
      db: {
        transaction: async (cb: (scope: { trx: object }) => unknown) => cb({ trx: {} }),
        query: () => ({ findOne: async () => user }),
      },
      plugin: () => ({ service: () => ({ send }) }),
      log: { info: vi.fn(), warn: vi.fn() },
    });
    vi.useFakeTimers();

    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 2 * MAX_RESET_JOBS; i++) await forgot();
      // Every wait for the transport times out; the sends go on.
      await vi.advanceTimersByTimeAsync(MAIL_TIMEOUT_MS + 1);
    }
    expect(send).toHaveBeenCalledTimes(MAX_RESET_JOBS);
    expect(peak).toBe(MAX_RESET_JOBS);

    // Once the transport has given up, the slots are free again.
    for (const release of releases.splice(0)) release();
    await vi.advanceTimersByTimeAsync(0);
    await forgot();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(MAX_RESET_JOBS + 1);
  });
});
