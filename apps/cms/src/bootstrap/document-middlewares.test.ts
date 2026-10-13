import { describe, expect, it, vi } from "vitest";

import { DOCUMENT_FILE_MIMES } from "../utils/authoring-checks";
import { MEDIA_CLAIM_FIELDS } from "../utils/media-claims";
import { WRITE_ALLOWLIST, type WriteAllowlist } from "../utils/write-allowlist";
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
      "media-claims",
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

  // The claim race (decision 06 §E3, Codex row 13): the allowlist's
  // `ownUpload` runs in the policy, before the transaction, so it only
  // refuses early. A media field the content API accepts is safe only with
  // the media claims wired: they lock the file row inside the document
  // lock's transaction, re-check it there (tombstone, links, stamp, mime)
  // and remove released files after the commit.
  it("wires the media claims for every media field the allowlist accepts", () => {
    const mediaFields = new Map<string, [string, string]>();
    for (const [uid, actions] of Object.entries(WRITE_ALLOWLIST as WriteAllowlist)) {
      for (const byClass of Object.values(actions)) {
        for (const rule of Object.values(byClass ?? {})) {
          for (const [key, spec] of Object.entries(rule.fields)) {
            if (spec.kind === "media") mediaFields.set(`${uid}.${key}`, [uid, key]);
          }
        }
      }
    }
    expect([...mediaFields.keys()]).toEqual(["api::document.document.file"]);
    for (const [field, [uid, key]] of mediaFields) {
      // Claimed, with the very mimes the early check admits.
      expect([...(MEDIA_CLAIM_FIELDS[uid]?.[key] ?? [])].sort(), field).toEqual(
        [...DOCUMENT_FILE_MIMES].sort(),
      );
    }
    const slots = documentMiddlewares(host(null)).map((entry) => entry.slot);
    expect(slots).toContain("media-claims");
    // Inside the lock's transaction, before the audit row is written.
    expect(slots.indexOf("media-claims")).toBeGreaterThan(slots.indexOf("document-lock"));
    expect(slots.indexOf("media-claims")).toBeLessThan(slots.indexOf("audit-recorder"));
  });

  it("refuses to boot without strapi.documents.use, registering nothing", () => {
    expect(() => registerDocumentMiddlewares(host({}))).toThrow(
      /^\[document-middlewares\] strapi\.documents\.use not found/,
    );
    expect(() => registerDocumentMiddlewares(host(null))).toThrow(/refusing to boot/);
  });
});
