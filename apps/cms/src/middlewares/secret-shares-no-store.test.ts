import { describe, expect, it, vi } from "vitest";

import middleware, { isSecretSharePath } from "./secret-shares-no-store";

describe("secret-shares-no-store", () => {
  it("matches the API and below, in any case or encoding", () => {
    for (const path of [
      "/api/secret-shares",
      "/api/secret-shares/abc/reveal",
      "/API/Secret-Shares/recipients",
      "/api/secret%2Dshares",
      "//api//secret-shares/x",
    ]) {
      expect(isSecretSharePath(path), path).toBe(true);
    }
    for (const path of ["/api/secret-sharesx", "/api/kudos-entries", "/secrets", "/api/%E0%A4%A"]) {
      expect(isSecretSharePath(path), path).toBe(false);
    }
  });

  it("sets the header before the route and again after an error was written", async () => {
    const set = vi.fn();
    const next = vi.fn(async () => {
      throw new Error("route failed");
    });
    await expect(middleware()({ path: "/api/secret-shares/x", set }, next)).rejects.toThrow();
    expect(set.mock.calls).toEqual([
      ["Cache-Control", "private, no-store"],
      ["Cache-Control", "private, no-store"],
    ]);
  });

  it("leaves other paths alone", async () => {
    const set = vi.fn();
    await middleware()({ path: "/api/kudos-entries", set }, async () => undefined);
    expect(set).not.toHaveBeenCalled();
  });
});
