import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../package.json";
import {
  brand,
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

/** v0.29 (S1): the branding keys, each optional; invalid values warn and keep the default. */
describe("brand", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  it("names a valid accent that fails the contrast checks", () => {
    expect(brand({ SITE_ACCENT: "#050505" }).palette).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fails the contrast checks"));
  });

  it("keeps the product's look without any key", () => {
    expect(brand({})).toEqual({ name: null, logoUrl: null, iconUrl: null, palette: null });
    expect(warn).not.toHaveBeenCalled();
  });

  it("takes a valid name, logo, icon and accent", () => {
    const result = brand({
      SITE_NAME: " Musterfirma ",
      SITE_LOGO_URL: "https://cdn.example.com/logo.svg",
      SITE_ICON_URL: "https://cdn.example.com/icon.png",
      SITE_ACCENT: "#0F766E",
    });
    expect(result).toMatchObject({
      name: "Musterfirma",
      logoUrl: "https://cdn.example.com/logo.svg",
      iconUrl: "https://cdn.example.com/icon.png",
    });
    expect(result.palette?.light.primary).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["SITE_NAME", "x".repeat(41)],
    ["SITE_NAME", "Acme\nBcc: x"],
    ["SITE_LOGO_URL", "http://cdn.example.com/logo.svg"],
    ["SITE_LOGO_URL", "/branding/logo.svg"],
    ["SITE_LOGO_URL", "//cdn.example.com/logo.svg"],
    ["SITE_LOGO_URL", "https:cdn.example.com/logo.svg"],
    ["SITE_LOGO_URL", "https:\\cdn.example.com\logo.svg"],
    ["SITE_LOGO_URL", "https://user:pass@cdn.example.com/logo.svg"],
    ["SITE_ICON_URL", "javascript:alert(1)"],
    ["SITE_ACCENT", "teal"],
    ["SITE_ACCENT", "#0000ff"],
    ["SITE_ACCENT", "#0f766e;}body{display:none"],
  ])("refuses %s=%j with one warning", (key, value) => {
    const result = brand({ [key]: value });
    expect(result).toEqual({ name: null, logoUrl: null, iconUrl: null, palette: null });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(key));
  });
});
