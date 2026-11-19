import { describe, expect, it } from "vitest";
import {
  QR_MAX_CHARACTERS,
  isTooMuchData,
  pngBlob,
  textPayload,
  vcardEscape,
  vcardPayload,
  wifiEscape,
  wifiPayload,
} from "./qr-code";

/**
 * The payload builders of /tools/qr: what each kind encodes, the escaping, and the refusal of
 * a field that could start a new line of the payload (no line injection).
 */
const char = String.fromCharCode;
/** Characters that can break a line, as a field value would carry them. */
const LINE_BREAKS = [
  ["LF", "\n"],
  ["CR", "\r"],
  ["CRLF", "\r\n"],
  ["NEL", char(0x85)],
  ["line separator", char(0x2028)],
  ["paragraph separator", char(0x2029)],
  ["NUL", char(0)],
  ["tab", "\t"],
  ["DEL", char(0x7f)],
] as const;

describe("textPayload", () => {
  it("keeps the text, cuts surrounding blanks, and keeps line breaks inside", () => {
    expect(textPayload("  https://example.org/a?b=c&d=e \n")).toEqual({
      ok: true,
      payload: "https://example.org/a?b=c&d=e",
    });
    expect(textPayload("a\nb")).toEqual({ ok: true, payload: "a\nb" });
  });

  it("refuses blank text, and text longer than any code can hold", () => {
    expect(textPayload(" \n ")).toEqual({ ok: false, issue: "empty" });
    expect(textPayload("x".repeat(QR_MAX_CHARACTERS))).toMatchObject({ ok: true });
    expect(textPayload("x".repeat(QR_MAX_CHARACTERS + 1))).toEqual({
      ok: false,
      issue: "tooMuchData",
    });
  });
});

describe("wifiPayload", () => {
  it("builds WIFI:T:<type>;S:<ssid>;P:<password>;;", () => {
    expect(wifiPayload({ ssid: "Office", password: "secret-pass", security: "WPA" })).toEqual({
      ok: true,
      payload: "WIFI:T:WPA;S:Office;P:secret-pass;;",
    });
    expect(wifiPayload({ ssid: "Old", password: "12345", security: "WEP" })).toEqual({
      ok: true,
      payload: "WIFI:T:WEP;S:Old;P:12345;;",
    });
  });

  it("an open network has no password entry, whatever the password field holds", () => {
    expect(wifiPayload({ ssid: "Guests", password: "ignored", security: "nopass" })).toEqual({
      ok: true,
      payload: "WIFI:T:nopass;S:Guests;;",
    });
  });

  it("escapes backslash, semicolon, comma, colon and quote, in the name and the password", () => {
    expect(wifiEscape('\\;,:"')).toBe('\\\\\\;\\,\\:\\"');
    expect(wifiPayload({ ssid: 'a"b;c', password: 'p\\q;r,s:t"u', security: "WPA" })).toEqual({
      ok: true,
      payload: 'WIFI:T:WPA;S:a\\"b\\;c;P:p\\\\q\\;r\\,s\\:t\\"u;;',
    });
  });

  it("cannot be made to end a field early or add one: a hostile value stays inside its field", () => {
    const result = wifiPayload({ ssid: "x;P:evil;T:nopass", password: "y;;", security: "WPA" });
    expect(result).toEqual({
      ok: true,
      payload: "WIFI:T:WPA;S:x\\;P\\:evil\\;T\\:nopass;P:y\\;\\;;;",
    });
  });

  it("keeps blanks in the name and the password as typed", () => {
    expect(wifiPayload({ ssid: " a b ", password: " pw ", security: "WPA" })).toEqual({
      ok: true,
      payload: "WIFI:T:WPA;S: a b ;P: pw ;;",
    });
  });

  it("needs a name, and a password unless the network is open", () => {
    expect(wifiPayload({ ssid: "", password: "pw", security: "WPA" })).toEqual({
      ok: false,
      issue: "ssidMissing",
    });
    expect(wifiPayload({ ssid: "Net", password: "", security: "WPA" })).toEqual({
      ok: false,
      issue: "passwordMissing",
    });
    expect(wifiPayload({ ssid: "Net", password: "", security: "nopass" })).toMatchObject({
      ok: true,
    });
  });

  it.each(LINE_BREAKS)("refuses %s in the name and in the password", (_name, value) => {
    for (const input of [
      { ssid: `a${value}b`, password: "pw" },
      { ssid: "a", password: `p${value}w` },
    ]) {
      expect(wifiPayload({ ...input, security: "WPA" })).toEqual({
        ok: false,
        issue: "controlCharacter",
      });
    }
  });
});

describe("vcardPayload", () => {
  const card = { givenName: "Max", familyName: "Muster", phone: "+49 30 1234", email: "m@x.de" };

  it("builds a 3.0 card with VERSION, N and FN, CRLF between the lines", () => {
    expect(vcardPayload(card)).toEqual({
      ok: true,
      payload:
        "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Muster;Max;;;\r\nFN:Max Muster\r\nTEL:+49 30 1234\r\nEMAIL:m@x.de\r\nEND:VCARD",
    });
  });

  it("needs only a name: a given name or a family name is enough, phone and email are optional", () => {
    const empty = { phone: "", email: "" };
    expect(vcardPayload({ ...empty, givenName: "Max", familyName: "" })).toEqual({
      ok: true,
      payload: "BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Max;;;\r\nFN:Max\r\nEND:VCARD",
    });
    expect(vcardPayload({ ...empty, givenName: "", familyName: "Muster" })).toEqual({
      ok: true,
      payload: "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Muster;;;;\r\nFN:Muster\r\nEND:VCARD",
    });
    expect(vcardPayload({ ...card, givenName: " ", familyName: "" })).toEqual({
      ok: false,
      issue: "nameMissing",
    });
  });

  it("escapes backslash, semicolon and comma, and turns a line break into \\n", () => {
    expect(vcardEscape("a\\b;c,d")).toBe("a\\\\b\\;c\\,d");
    expect(vcardEscape("a\nb\r\nc\rd")).toBe("a\\nb\\nc\\nd");
    const result = vcardPayload({
      givenName: "Max;Moritz",
      familyName: "Muster, Jr.",
      phone: "",
      email: "a;b@x.de",
    });
    expect(result).toEqual({
      ok: true,
      payload:
        "BEGIN:VCARD\r\nVERSION:3.0\r\nN:Muster\\, Jr.;Max\\;Moritz;;;\r\nFN:Max\\;Moritz Muster\\, Jr.\r\nEMAIL:a\\;b@x.de\r\nEND:VCARD",
    });
  });

  it.each(LINE_BREAKS)(
    "refuses %s in every field, so no line of one's own can be injected",
    (_name, value) => {
      for (const field of ["givenName", "familyName", "phone", "email"] as const) {
        const result = vcardPayload({ ...card, [field]: `x${value}END:VCARD${value}BEGIN:VCARD` });
        expect(result, field).toEqual({ ok: false, issue: "controlCharacter" });
      }
    },
  );

  it("looks at its four fields only, not at the other state a page hands in", () => {
    const state = { ...card, ssid: `a${char(0x2028)}b`, password: "x\ny", text: "t\r\n" };
    expect(vcardPayload(state)).toEqual(vcardPayload(card));
    expect(vcardPayload(state)).toMatchObject({ ok: true });
  });

  it("an injection attempt never reaches the payload, however it is spelled", () => {
    const attempt = vcardPayload({ ...card, familyName: "Muster\r\nEND:VCARD\r\nBEGIN:VCARD" });
    expect(attempt.ok).toBe(false);
    const lines = (vcardPayload(card) as { payload: string }).payload.split("\r\n");
    expect(lines.filter((line) => line === "END:VCARD")).toHaveLength(1);
    expect(lines.filter((line) => line === "BEGIN:VCARD")).toHaveLength(1);
  });
});

describe("the qrcode library's refusal", () => {
  it("is recognised as too much data, whatever its wording for the limit", async () => {
    const { default: QRCode } = await import("qrcode");
    let error: unknown;
    try {
      QRCode.create("x".repeat(3000), { errorCorrectionLevel: "M" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(isTooMuchData(error)).toBe(true);
    expect(isTooMuchData(new Error("something else"))).toBe(false);
    expect(isTooMuchData("too big")).toBe(false);
  });

  it("holds an ordinary payload at level M", async () => {
    const { default: QRCode } = await import("qrcode");
    const qr = QRCode.create("WIFI:T:WPA;S:Office;P:secret-pass;;", { errorCorrectionLevel: "M" });
    expect(qr.version).toBeGreaterThan(0);
    expect(qr.errorCorrectionLevel.bit).toBe(0); // M
  });
});

describe("pngBlob", () => {
  it("decodes a data URL into a PNG blob with the same bytes", async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]);
    const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    const blob = pngBlob(dataUrl);
    expect(blob.type).toBe("image/png");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });
});
