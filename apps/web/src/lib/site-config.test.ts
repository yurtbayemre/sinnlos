import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json";
import {
  DEFAULT_SOURCE_URL,
  plausibleScript,
  shortRevision,
  siteLinks,
  VERSION,
} from "./site-config";

/** v0.26 (M1-M3): the footer's release and links and the analytics gate come from the runtime env. */
describe("site config", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  it("reports the web package's version", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("offers the upstream source unless SOURCE_URL names a valid http(s) URL", () => {
    expect(siteLinks({}).source).toBe(DEFAULT_SOURCE_URL);
    expect(siteLinks({ SOURCE_URL: "https://git.example.com/fork" }).source).toBe(
      "https://git.example.com/fork",
    );
    expect(siteLinks({ SOURCE_URL: "javascript:alert(1)" }).source).toBe(DEFAULT_SOURCE_URL);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("shows a legal link only for an http(s) URL", () => {
    const links = siteLinks({
      PRIVACY_URL: " https://example.com/privacy ",
      IMPRINT_URL: "example.com/imprint",
      WHISTLEBLOWING_URL: "",
    });
    expect(links).toMatchObject({
      privacy: "https://example.com/privacy",
      imprint: null,
      whistleblowing: null,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("IMPRINT_URL"));
  });

  it("shortens a known revision and hides an unknown one", () => {
    expect(shortRevision({ SINNLOS_REVISION: "0c26656e98f9" })).toBe("0c26656");
    expect(shortRevision({ SINNLOS_REVISION: "unknown" })).toBeNull();
    expect(shortRevision({})).toBeNull();
  });

  it("loads analytics only with an https script URL and a domain", () => {
    const src = "https://plausible.example.com/js/script.js";
    expect(plausibleScript({})).toBeNull();
    expect(plausibleScript({ PLAUSIBLE_SCRIPT_URL: src })).toBeNull();
    expect(plausibleScript({ PLAUSIBLE_DOMAIN: "intranet.example.com" })).toBeNull();
    expect(
      plausibleScript({
        PLAUSIBLE_SCRIPT_URL: src.replace("https", "http"),
        PLAUSIBLE_DOMAIN: "x",
      }),
    ).toBeNull();
    expect(
      plausibleScript({ PLAUSIBLE_SCRIPT_URL: src, PLAUSIBLE_DOMAIN: "intranet.example.com" }),
    ).toEqual({ src, domain: "intranet.example.com" });
  });
});
