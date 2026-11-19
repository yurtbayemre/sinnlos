/**
 * What /tools/qr puts into a QR code (v1.1 "Tools"): free text or a link, a Wi-Fi login and
 * a contact. The builders are pure; the page hands their text to `qrcode` in the browser and
 * nothing is stored or sent (components/tools/browser-tools.test.ts). Each builder either
 * returns the text to encode or the reason it refuses, as a code the page turns into a message.
 */

/**
 * The most characters any QR code holds: version 40, numeric mode, error correction M. A
 * longer text is refused at once; a shorter one that still does not fit (qrcode throws) is
 * "too much data" as well (`isTooMuchData`).
 */
export const QR_MAX_CHARACTERS = 5596;

export type QrIssue =
  "empty" | "ssidMissing" | "passwordMissing" | "nameMissing" | "controlCharacter" | "tooMuchData";

export type QrPayload = { ok: true; payload: string } | { ok: false; issue: QrIssue };

const refuse = (issue: QrIssue): QrPayload => ({ ok: false, issue });
const accept = (payload: string): QrPayload =>
  payload.length > QR_MAX_CHARACTERS ? refuse("tooMuchData") : { ok: true, payload };

/**
 * Control characters (CR, LF, NUL, DEL and the C1 range with NEL) and the Unicode line and
 * paragraph separators (categories Zl and Zp): in a Wi-Fi or contact field they can only be an
 * attempt to start a new line of the payload, so the field is refused instead of cleaned.
 */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** A link or any text, as typed (surrounding blanks cut). */
export function textPayload(text: string): QrPayload {
  return text.trim() === "" ? refuse("empty") : accept(text.trim());
}

export type WifiSecurity = "WPA" | "WEP" | "nopass";

/** `\ ; , : "` get a backslash in a Wi-Fi field (the ZXing / Android `WIFI:` format). */
export const wifiEscape = (value: string) => value.replace(/[\\;,:"]/g, "\\$&");

/**
 * `WIFI:T:WPA;S:<ssid>;P:<password>;;`. WPA covers WPA2 and WPA3, `nopass` is an open
 * network (no `P:`). The name and the password are kept as typed, blanks included.
 * shortcut: no hidden-network flag (`H:true`) and no quoting of an all-hex name, which
 * some phones read as a hex string; add both when someone needs them.
 */
export function wifiPayload(input: {
  ssid: string;
  password: string;
  security: WifiSecurity;
}): QrPayload {
  const { ssid, password, security } = input;
  if (CONTROL.test(ssid) || CONTROL.test(password)) return refuse("controlCharacter");
  if (ssid === "") return refuse("ssidMissing");
  if (security !== "nopass" && password === "") return refuse("passwordMissing");
  const secret = security === "nopass" ? "" : `P:${wifiEscape(password)};`;
  return accept(`WIFI:T:${security};S:${wifiEscape(ssid)};${secret};`);
}

/**
 * vCard 3.0 text (RFC 2426): `\ ; ,` get a backslash and a line break becomes `\n`.
 * The builder refuses line breaks before it gets here, so the last rule is a second lock.
 */
export const vcardEscape = (value: string) =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");

/**
 * Folds a vCard content line at 75 octets (RFC 2426 section 2.6): the rest goes on lines that
 * start with one space, and a UTF-8 character is never cut in two. Unfolding (CRLF and the
 * space removed) gives the line back.
 */
export function foldVcardLine(line: string): string {
  const encoder = new TextEncoder();
  const physical: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (octets + size > 75) {
      physical.push(current);
      current = " ";
      octets = 1;
    }
    current += char;
    octets += size;
  }
  physical.push(current);
  return physical.join("\r\n");
}

/**
 * A contact card with `VERSION`, `N` and `FN` always present: a given name, a family name or
 * both (one is enough), then an optional phone and email. Every line, the last one included,
 * ends in CRLF and is folded at 75 octets, as the format asks. A control character, line
 * breaks included, in any field is refused (no way to add a line of one's own).
 */
export function vcardPayload(input: {
  givenName: string;
  familyName: string;
  phone: string;
  email: string;
}): QrPayload {
  // Only the four fields count: the page hands in all of its state.
  const raw = [input.givenName, input.familyName, input.phone, input.email];
  if (raw.some((value) => CONTROL.test(value))) return refuse("controlCharacter");
  const [given, family, phone, email] = raw.map((value) => value.trim()) as [
    string,
    string,
    string,
    string,
  ];
  if (given === "" && family === "") return refuse("nameMissing");
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${vcardEscape(family)};${vcardEscape(given)};;;`,
    `FN:${vcardEscape([given, family].filter(Boolean).join(" "))}`,
  ];
  if (phone) lines.push(`TEL:${vcardEscape(phone)}`);
  if (email) lines.push(`EMAIL:${vcardEscape(email)}`);
  lines.push("END:VCARD");
  return accept(lines.map((line) => `${foldVcardLine(line)}\r\n`).join(""));
}

/** Whether `qrcode` refused a text because it does not fit into any code (its messages). */
export function isTooMuchData(error: unknown): boolean {
  return error instanceof Error && /too big|cannot contain|amount of data/i.test(error.message);
}

/** The bytes of a `data:image/png;base64,...` URL as a Blob, for the download. */
export function pngBlob(dataUrl: string): Blob {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  return new Blob([Uint8Array.from(binary, (char) => char.charCodeAt(0))], { type: "image/png" });
}

/** A code as the page shows and offers it: the PNG as a data URL, the SVG as text. */
export interface QrImages {
  png: string;
  svg: string;
}

/**
 * Makes the PNG and the SVG of a payload at level M, width in pixels. The library loads on
 * the first call (`load`, a dynamic import(): no other page carries it). Runs are numbered:
 * `invalidate()` (the page's fields changed) or a newer `make()` turns every answer still on
 * its way into `null`, so a page never shows a code for what its fields no longer say. A
 * text that does not fit answers `"tooMuchData"`, any other failure `"failed"`.
 */
export function createQrMaker(
  load: () => Promise<{ default: Pick<typeof import("qrcode"), "toDataURL" | "toString"> }> = () =>
    import("qrcode"),
) {
  let newest = 0;
  return {
    invalidate(): void {
      newest += 1;
    },
    async make(
      payload: string,
      width: number,
    ): Promise<QrImages | "tooMuchData" | "failed" | null> {
      const run = ++newest;
      try {
        const { default: QRCode } = await load();
        const options = { errorCorrectionLevel: "M", width } as const;
        const [png, svg] = await Promise.all([
          QRCode.toDataURL(payload, options),
          QRCode.toString(payload, { ...options, type: "svg" }),
        ]);
        return run === newest ? { png, svg } : null;
      } catch (error) {
        if (run !== newest) return null;
        return isTooMuchData(error) ? "tooMuchData" : "failed";
      }
    },
  };
}
