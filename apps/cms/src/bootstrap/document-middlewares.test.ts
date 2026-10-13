import { describe, expect, it, vi } from "vitest";

import {
  DOCUMENT_MIDDLEWARE_SLOTS,
  documentMiddlewares,
  registerDocumentMiddlewares,
  type DocumentMiddlewaresRegistrationHost,
} from "./document-middlewares";

/**
 * The slot order of the Document Service middlewares (decision 06 §K,
 * batch 15 plan S1, contract K6). Strapi runs them in registration order,
 * the first registered outermost (C4, framework-contract.test.ts).
 */

function host(documents: DocumentMiddlewaresRegistrationHost["documents"]) {
  return {
    config: { get: () => undefined },
    db: {
      query: () => ({
        findOne: async () => null,
        findMany: async () => [],
        updateMany: async () => ({ count: 0 }),
      }),
      connection: { raw: async () => ({}) },
      inTransaction: () => false,
      transaction: async <T>(callback: (scope: { trx: never }) => Promise<T>) =>
        callback({ trx: undefined as never }),
      dialect: { client: "sqlite" },
      getSchemaName: () => undefined,
      metadata: { get: () => ({ tableName: "t", attributes: {} }) },
    },
    plugin: () => ({ service: () => ({}) }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    documents,
  } as unknown as DocumentMiddlewaresRegistrationHost;
}

describe("Document Service middleware slots (K6)", () => {
  it("fixes the slot order, outermost first", () => {
    expect(DOCUMENT_MIDDLEWARE_SLOTS).toEqual([
      "offsetless-datetime-guard",
      "document-lock",
      "poll-audience-guard",
      "department-audience-guard",
      "wiki-checks",
      "schedule-clear",
      "publish-readiness",
      "media-claims",
      "audit-recorder",
      "user-write-guard",
    ]);
  });

  it("registers the wired middlewares in slot order; the user write guard last", () => {
    const slots = documentMiddlewares(host(null)).map((entry) => entry.slot);
    expect(slots).toEqual(
      [...slots].sort(
        (a, b) => DOCUMENT_MIDDLEWARE_SLOTS.indexOf(a) - DOCUMENT_MIDDLEWARE_SLOTS.indexOf(b),
      ),
    );
    expect(slots).toEqual([
      "offsetless-datetime-guard",
      "document-lock",
      "poll-audience-guard",
      "department-audience-guard",
      "schedule-clear",
      "publish-readiness",
      "audit-recorder",
      "user-write-guard",
    ]);
    expect(slots[slots.length - 1]).toBe("user-write-guard");
  });

  it("hangs each one onto strapi.documents.use, in that order", () => {
    const use = vi.fn();
    const strapi = host({ use });
    registerDocumentMiddlewares(strapi);
    expect(use).toHaveBeenCalledTimes(documentMiddlewares(strapi).length);
  });

  it("refuses to boot without strapi.documents.use, registering nothing", () => {
    expect(() => registerDocumentMiddlewares(host({}))).toThrow(
      /^\[document-middlewares\] strapi\.documents\.use not found/,
    );
    expect(() => registerDocumentMiddlewares(host(null))).toThrow(/refusing to boot/);
  });
});
