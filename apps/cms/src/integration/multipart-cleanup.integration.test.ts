import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestStrapi, type TestStrapi } from "./harness.test.helper";
import { PNG_1PX, uploadFiles } from "./upload.test.helper";

/**
 * The multipart cleanup (v0.34, C1) in the booted cms: the audit's
 * anonymous requests leave nothing in the temp dir, and a real upload still
 * works. formidable's temp dir is os.tmpdir() at its load, so the boot
 * points TMPDIR/TMP/TEMP at a fresh directory; only formidable's own names
 * (cuid2, 25 characters) count, anything else Strapi puts there is ignored.
 */

const FORMIDABLE_NAME = /^[a-z][a-z0-9]{24}$/;

describe("multipart temp files in the booted cms (C1)", () => {
  let t: TestStrapi;
  let dir = "";
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sinnlos-it-multipart-"));
    t = await createTestStrapi({ env: { TMPDIR: dir, TMP: dir, TEMP: dir } });
  });
  afterAll(async () => {
    await t?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const leftovers = () => readdirSync(dir).filter((name) => FORMIDABLE_NAME.test(name));

  async function anonymous(path: string, fields: Array<[string, string]>) {
    const form = new FormData();
    for (const [field, name] of fields) {
      form.append(field, new Blob([new Uint8Array(4096)], { type: "application/pdf" }), name);
    }
    return fetch(`${t.baseUrl}${path}`, { method: "POST", body: form });
  }

  it("an anonymous file under another field name: refused, nothing left (/api/upload)", async () => {
    const res = await anonymous("/api/upload", [["orphan", "o.pdf"]]);
    expect(res.status).toBe(403);
    expect(leftovers()).toEqual([]);
  });

  it("an anonymous multipart POST to a content route, `__proto__` twice: refused, nothing left", async () => {
    const res = await anonymous("/api/announcements", [
      ["x", "x.pdf"],
      ["__proto__", "p1.pdf"],
      ["__proto__", "p2.pdf"],
    ]);
    expect(res.status).toBe(403);
    expect(leftovers()).toEqual([]);
  });

  it("a member's image upload still works and leaves nothing", async () => {
    const jwt = await t.loginAs("member");
    const res = await uploadFiles(t, jwt, [{ name: "p.png", bytes: PNG_1PX, type: "image/png" }]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(leftovers()).toEqual([]);
  });
});
