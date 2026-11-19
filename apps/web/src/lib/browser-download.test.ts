import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadBlob } from "./browser-download";

/** The object URL of a download is revoked after the click, in a later task, once. */
describe("downloadBlob", () => {
  const link = { href: "", download: "", click: vi.fn() };
  const create = vi.fn(() => "blob:test-1");
  const revoke = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    link.click.mockClear();
    create.mockClear();
    revoke.mockClear();
    vi.stubGlobal("document", { createElement: () => link });
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("clicks a link to the object URL with the file name, then revokes the URL later", () => {
    const blob = new Blob(["x"], { type: "application/pdf" });
    downloadBlob(blob, "merged.pdf");
    expect(create).toHaveBeenCalledWith(blob);
    expect(link).toMatchObject({ href: "blob:test-1", download: "merged.pdf" });
    expect(link.click).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:test-1");
  });
});
