import { describe, expect, it } from "vitest";

import {
  ICS_LINE_OCTETS,
  MAX_DESCRIPTION_CHARS,
  buildIcs,
  escapeIcsText,
  foldIcsLine,
  icsContentDisposition,
  icsEventDateLines,
  icsSequence,
  markdownToPlainText,
  type IcsEvent,
} from "./ics";

const NOW = "2026-09-24T08:15:30.123Z";
const BERLIN = "Europe/Berlin";
const DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";

const EVENT: IcsEvent = {
  documentId: DOC,
  title: "Summer party",
  start: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-09-20T12:00:00.000Z",
};

/** The physical lines of an ICS body (CRLF-separated, trailing CRLF). */
function physicalLines(body: string): string[] {
  expect(body.endsWith("\r\n")).toBe(true);
  return body.slice(0, -2).split("\r\n");
}

/** The content lines after unfolding (RFC 5545 3.1). */
function contentLines(body: string): string[] {
  return body.slice(0, -2).replace(/\r\n /g, "").split("\r\n");
}

function property(body: string, name: string): string | undefined {
  const line = contentLines(body).find((l) => l.startsWith(`${name}:`) || l.startsWith(`${name};`));
  return line?.slice(line.indexOf(":") + 1);
}

/** Undoes TEXT escaping (for round-trip checks). */
function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function octets(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

describe("icsEventDateLines", () => {
  it("writes timed events in UTC with Z (DTEND = DTSTART without an end)", () => {
    expect(icsEventDateLines({ start: "2026-10-01T10:00:00.000Z" }, NOW, BERLIN)).toEqual([
      "DTSTAMP:20260924T081530Z",
      "DTSTART:20261001T100000Z",
      "DTEND:20261001T100000Z",
    ]);
    expect(
      icsEventDateLines(
        { start: "2026-10-01T10:00:00.000Z", end: "2026-10-01T11:30:00.000Z", allDay: false },
        NOW,
        BERLIN,
      ),
    ).toEqual(["DTSTAMP:20260924T081530Z", "DTSTART:20261001T100000Z", "DTEND:20261001T113000Z"]);
  });

  it("treats an empty end like a missing one", () => {
    expect(icsEventDateLines({ start: "2026-10-01T10:00:00.000Z", end: "" }, NOW, BERLIN)[2]).toBe(
      "DTEND:20261001T100000Z",
    );
  });

  it("writes an all-day event as VALUE=DATE with an exclusive DTEND", () => {
    // Entered as local midnight in Berlin (22:00Z the day before).
    expect(
      icsEventDateLines({ start: "2026-09-30T22:00:00.000Z", allDay: true }, NOW, BERLIN),
    ).toEqual([
      "DTSTAMP:20260924T081530Z",
      "DTSTART;VALUE=DATE:20261001",
      "DTEND;VALUE=DATE:20261002",
    ]);
  });

  it("covers every day of a multi-day all-day event across the DST change", () => {
    // Sat 2026-10-24 00:00 CEST to Mon 2026-10-26 00:00 CET, inclusive days.
    const lines = icsEventDateLines(
      { start: "2026-10-23T22:00:00.000Z", end: "2026-10-25T23:00:00.000Z", allDay: true },
      NOW,
      BERLIN,
    );
    expect(lines.slice(1)).toEqual(["DTSTART;VALUE=DATE:20261024", "DTEND;VALUE=DATE:20261027"]);
    // And into summer time (2027-03-28).
    const spring = icsEventDateLines(
      { start: "2027-03-27T23:00:00.000Z", end: "2027-03-28T22:00:00.000Z", allDay: true },
      NOW,
      BERLIN,
    );
    expect(spring.slice(1)).toEqual(["DTSTART;VALUE=DATE:20270328", "DTEND;VALUE=DATE:20270330"]);
  });

  it("takes the days in the business zone, not in UTC", () => {
    const event = { start: "2026-10-01T02:00:00.000Z", allDay: true };
    expect(icsEventDateLines(event, NOW, BERLIN)[1]).toBe("DTSTART;VALUE=DATE:20261001");
    expect(icsEventDateLines(event, NOW, "America/New_York")[1]).toBe(
      "DTSTART;VALUE=DATE:20260930",
    );
  });

  it("never ends an all-day event before it starts", () => {
    const lines = icsEventDateLines(
      { start: "2026-10-05T10:00:00.000Z", end: "2026-10-01T10:00:00.000Z", allDay: true },
      NOW,
      BERLIN,
    );
    expect(lines.slice(1)).toEqual(["DTSTART;VALUE=DATE:20261005", "DTEND;VALUE=DATE:20261006"]);
  });
});

describe("escapeIcsText (RFC 5545 TEXT)", () => {
  it("escapes backslash, semicolon and comma", () => {
    expect(escapeIcsText("a\\b;c,d")).toBe("a\\\\b\\;c\\,d");
    expect(escapeIcsText("\\;")).toBe("\\\\\\;");
  });

  it("writes every line break as backslash-n", () => {
    expect(escapeIcsText("one\r\ntwo\nthree\rfour")).toBe("one\\ntwo\\nthree\\nfour");
    expect(escapeIcsText("a\\nb")).toBe("a\\\\nb");
  });

  it("drops other control characters but keeps tabs and non-ASCII text", () => {
    expect(escapeIcsText("a\u0000b\u0007c\u001bd\u007fe\tf")).toBe("abcde\tf");
    expect(escapeIcsText("Sommerfest – 5 € 🎉 „Grüße“")).toBe("Sommerfest – 5 € 🎉 „Grüße“");
  });

  it("round-trips through unescaping", () => {
    const text = "Raum 3; Ebene 2, Flügel C\\Nord\nBitte pünktlich";
    expect(unescapeText(escapeIcsText(text))).toBe(text);
  });
});

describe("foldIcsLine (75 octets, UTF-8 safe)", () => {
  it("leaves a line of exactly 75 octets alone and folds a longer one", () => {
    const exact = `SUMMARY:${"a".repeat(ICS_LINE_OCTETS - 8)}`;
    expect(octets(exact)).toBe(75);
    expect(foldIcsLine(exact)).toBe(exact);
    const folded = foldIcsLine(`${exact}b`);
    expect(folded).toBe(`${exact}\r\n b`);
  });

  it("never splits a multi-byte character at the boundary", () => {
    // 74 ASCII octets, then characters of 2, 3 and 4 octets straddling 75.
    for (const char of ["ä", "–", "€", "🎉"]) {
      const line = `SUMMARY:${"x".repeat(66)}${char.repeat(40)}`;
      const folded = foldIcsLine(line);
      const parts = folded.split("\r\n");
      expect(parts.length).toBeGreaterThan(1);
      for (const [i, part] of parts.entries()) {
        expect(octets(part), `${char} part ${i}`).toBeLessThanOrEqual(ICS_LINE_OCTETS);
        if (i > 0) expect(part.startsWith(" ")).toBe(true);
        // Whole characters only: a split surrogate pair would not survive
        // the UTF-8 round trip (it becomes U+FFFD).
        expect(Buffer.from(part, "utf8").toString("utf8")).toBe(part);
      }
      expect(folded.replace(/\r\n /g, "")).toBe(line);
    }
  });

  it("fills the first line up to the character that would exceed 75 octets", () => {
    const line = `${"x".repeat(74)}€y`; // € would end at octet 77
    const [first, second] = foldIcsLine(line).split("\r\n");
    expect(first).toBe("x".repeat(74));
    expect(second).toBe(" €y");
  });

  it("replaces a lone surrogate instead of producing invalid UTF-8", () => {
    expect(foldIcsLine("SUMMARY:a\uD83Db")).toBe("SUMMARY:a�b");
  });
});

describe("markdownToPlainText (DESCRIPTION)", () => {
  it("drops Markdown markers and keeps the text", () => {
    const markdown = [
      "# Sommerfest",
      "",
      "Wir feiern **gemeinsam** auf der _Dachterrasse_, bitte `Badge` mitbringen.",
      "",
      "> Hinweis: ~~Freitag~~ Samstag!",
      "",
      "* Essen",
      "+ Getränke",
      "- Musik",
      "",
      "---",
      "",
      "Anmeldung: [Formular](https://intranet.example/forms/42) oder <https://example.org>",
      "![Plan](https://intranet.example/uploads/plan.png)",
    ].join("\n");
    expect(markdownToPlainText(markdown)).toBe(
      [
        "Sommerfest",
        "",
        "Wir feiern gemeinsam auf der Dachterrasse, bitte Badge mitbringen.",
        "",
        "Hinweis: Freitag Samstag!",
        "",
        "- Essen",
        "- Getränke",
        "- Musik",
        "",
        "Anmeldung: Formular (https://intranet.example/forms/42) oder https://example.org",
        "Plan",
      ].join("\n"),
    );
  });

  it("keeps snake_case words, arithmetic and escaped characters", () => {
    expect(markdownToPlainText("file_name_here and 2*3*4")).toBe("file_name_here and 2*3*4");
    expect(markdownToPlainText("\\*nicht fett\\* und 5\\_000")).toBe("*nicht fett* und 5_000");
  });

  it("drops HTML tags and comments and decodes common entities", () => {
    expect(markdownToPlainText("<p>Hallo<br>Welt</p><!-- intern --> &amp; &lt;tag&gt;")).toBe(
      "Hallo\nWelt & <tag>",
    );
  });

  it("normalises line breaks and collapses blank runs", () => {
    expect(markdownToPlainText("a\r\n\r\n\r\n\r\nb  \r\nc\n\n")).toBe("a\n\nb\nc");
  });
});

describe("icsSequence", () => {
  it("grows with updatedAt and is 0 without one", () => {
    const earlier = icsSequence("2026-09-20T12:00:00.000Z");
    const later = icsSequence("2026-09-20T12:00:01.000Z");
    expect(later).toBe(earlier + 1);
    expect(icsSequence("2026-09-21T12:00:00.000Z")).toBeGreaterThan(later);
    for (const missing of [null, undefined, "", "garbage", "2026-09-20T12:00:00"]) {
      expect(icsSequence(missing)).toBe(0);
    }
    expect(icsSequence("2023-12-31T23:59:59.000Z")).toBe(0);
    expect(icsSequence("2024-01-01T00:00:01.000Z")).toBe(1);
  });

  it("stays an RFC 5545 INTEGER", () => {
    expect(icsSequence("2099-01-01T00:00:00.000Z")).toBe(2147483647);
  });
});

describe("icsContentDisposition (RFC 6266)", () => {
  it("keeps a plain ASCII title in both parameters", () => {
    expect(icsContentDisposition("Summer party")).toBe(
      "attachment; filename=\"Summer party.ics\"; filename*=UTF-8''Summer%20party.ics",
    );
  });

  it("gives non-ASCII titles an ASCII fallback and a UTF-8 name", () => {
    expect(icsContentDisposition("Sommerfest – Grüße für 5 € 🎉")).toBe(
      'attachment; filename="Sommerfest - Gruesse fuer 5 EUR.ics"; ' +
        "filename*=UTF-8''Sommerfest%20%E2%80%93%20Gr%C3%BC%C3%9Fe%20f%C3%BCr%205%20%E2%82%AC%20%F0%9F%8E%89.ics",
    );
    expect(icsContentDisposition("Café „Kickoff“")).toBe(
      "attachment; filename=\"Cafe Kickoff.ics\"; filename*=UTF-8''Caf%C3%A9%20%E2%80%9EKickoff%E2%80%9C.ics",
    );
  });

  it("strips quotes, backslashes and control characters from the fallback", () => {
    const header = icsContentDisposition('Say "hi"\\ now\r\nSet-Cookie: x=1');
    expect(header.startsWith('attachment; filename="Say hi- nowSet-Cookie: x=1.ics"; ')).toBe(true);
    expect(header).not.toMatch(/[\r\n]/);
    // Percent-encoded everything outside RFC 8187 attr-char, incl. ' ( ) *.
    expect(icsContentDisposition("it's (a) *test*")).toBe(
      "attachment; filename=\"it's (a) *test*.ics\"; filename*=UTF-8''it%27s%20%28a%29%20%2Atest%2A.ics",
    );
  });

  it("falls back to 'event' for an empty or non-ASCII-only title", () => {
    for (const title of [null, undefined, "", "   ", "🎉🎉"]) {
      expect(icsContentDisposition(title)).toMatch(/^attachment; filename="event\.ics"; /);
    }
    expect(icsContentDisposition(null)).toBe(
      "attachment; filename=\"event.ics\"; filename*=UTF-8''event.ics",
    );
  });

  it("is always a valid Node header value (printable ASCII)", () => {
    for (const title of [
      "Sommerfest – 2026",
      "5 €",
      "🎉 Party",
      "\u0000\u0085x",
      "a\uD800b",
      "日本語",
    ]) {
      const header = icsContentDisposition(title);
      expect(header, title).toMatch(/^[\x20-\x7E]+$/);
    }
  });
});

describe("buildIcs", () => {
  it("builds the calendar with UID, dates, SEQUENCE and LAST-MODIFIED", () => {
    const file = buildIcs(
      { ...EVENT, location: "Roof; terrace, Berlin", url: "https://intranet.example/e/1" },
      { tz: BERLIN, now: NOW },
    );
    expect(file.contentType).toBe("text/calendar; charset=utf-8");
    expect(file.body).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Sinnlos//Events//EN",
        "BEGIN:VEVENT",
        `UID:event-${DOC}@sinnlos`,
        "DTSTAMP:20260924T081530Z",
        "DTSTART:20261001T100000Z",
        "DTEND:20261001T100000Z",
        `SEQUENCE:${icsSequence(EVENT.updatedAt)}`,
        "LAST-MODIFIED:20260920T120000Z",
        "SUMMARY:Summer party",
        "LOCATION:Roof\\; terrace\\, Berlin",
        "URL:https://intranet.example/e/1",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
  });

  it("keeps the UID across a re-publish and raises SEQUENCE", () => {
    const before = buildIcs(EVENT, { tz: BERLIN, now: NOW }).body;
    const republished = buildIcs(
      { ...EVENT, title: "Summer party (moved)", updatedAt: "2026-09-25T09:00:00.000Z" },
      { tz: BERLIN, now: "2026-09-25T10:00:00.000Z" },
    ).body;
    expect(property(before, "UID")).toBe(`event-${DOC}@sinnlos`);
    expect(property(republished, "UID")).toBe(property(before, "UID"));
    expect(Number(property(republished, "SEQUENCE"))).toBeGreaterThan(
      Number(property(before, "SEQUENCE")),
    );
    expect(property(republished, "LAST-MODIFIED")).toBe("20260925T090000Z");
  });

  it("omits LAST-MODIFIED and uses SEQUENCE 0 without updatedAt", () => {
    const body = buildIcs({ ...EVENT, updatedAt: null }, { tz: BERLIN, now: NOW }).body;
    expect(property(body, "SEQUENCE")).toBe("0");
    expect(property(body, "LAST-MODIFIED")).toBeUndefined();
  });

  it("handles en dash, euro sign and emoji titles: escaped, folded, ≤ 75 octets", () => {
    for (const title of [
      "Sommerfest – Teil 2",
      "Kostenbeitrag 5 €",
      "🎉 Launch-Party 🎉",
      `Workshop – ${"Ärger, Grüße; Übung ".repeat(8)}🎉€–`,
    ]) {
      const file = buildIcs({ ...EVENT, title }, { tz: BERLIN, now: NOW });
      for (const line of physicalLines(file.body)) {
        expect(octets(line), line).toBeLessThanOrEqual(ICS_LINE_OCTETS);
        expect(line).not.toContain("�");
      }
      expect(unescapeText(property(file.body, "SUMMARY") ?? "")).toBe(title);
      expect(file.contentDisposition).toMatch(/^[\x20-\x7E]+$/);
    }
  });

  it("writes the richtext description as escaped plain text", () => {
    const file = buildIcs(
      { ...EVENT, description: "## Ablauf\n\n**18:00** Start, danach *Buffet*; Ende offen" },
      { tz: BERLIN, now: NOW },
    );
    expect(property(file.body, "DESCRIPTION")).toBe(
      "Ablauf\\n\\n18:00 Start\\, danach Buffet\\; Ende offen",
    );
  });

  it("cuts a long description before the Markdown conversion (quadratic rules)", () => {
    // Openers without a closer make several Markdown rules rescan the rest
    // of the input from every position: uncut, 64K characters took seconds.
    for (const description of [
      "[".repeat(200_000),
      "![".repeat(100_000),
      "**a ".repeat(50_000),
      "~~a ".repeat(50_000),
      "<a".repeat(100_000),
      "<!--".repeat(50_000),
    ]) {
      const label = description.slice(0, 4);
      const started = performance.now();
      const body = buildIcs({ ...EVENT, description }, { tz: BERLIN, now: NOW }).body;
      expect(performance.now() - started, label).toBeLessThan(250);
      const text = property(body, "DESCRIPTION");
      expect(text, label).toBeDefined();
      expect(text?.endsWith("…"), label).toBe(true);
      expect(text?.length ?? 0, label).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS * 2 + 1);
    }
  });

  it("keeps a description up to the cap whole and never splits a surrogate pair", () => {
    const whole = "a".repeat(MAX_DESCRIPTION_CHARS);
    const kept = buildIcs({ ...EVENT, description: whole }, { tz: BERLIN, now: NOW }).body;
    expect(property(kept, "DESCRIPTION")).toBe(whole);
    const emojiAtCut = `${"a".repeat(MAX_DESCRIPTION_CHARS - 1)}🎉b`;
    const cut = buildIcs({ ...EVENT, description: emojiAtCut }, { tz: BERLIN, now: NOW }).body;
    expect(property(cut, "DESCRIPTION")).toBe(`${"a".repeat(MAX_DESCRIPTION_CHARS - 1)}…`);
  });

  it("omits empty LOCATION, DESCRIPTION and non-http URLs", () => {
    const body = buildIcs(
      { ...EVENT, location: "  ", description: "<!-- -->", url: "javascript:alert(1)" },
      { tz: BERLIN, now: NOW },
    ).body;
    expect(property(body, "LOCATION")).toBeUndefined();
    expect(property(body, "DESCRIPTION")).toBeUndefined();
    expect(property(body, "URL")).toBeUndefined();
    const withNewline = buildIcs(
      { ...EVENT, url: "https://a.example/x\r\nX-EVIL:1" },
      { now: NOW },
    ).body;
    expect(contentLines(withNewline).some((l) => l.startsWith("X-EVIL"))).toBe(false);
  });

  it("keeps a title with line breaks on one content line", () => {
    const body = buildIcs(
      { ...EVENT, title: "Line one\r\nEND:VEVENT" },
      { tz: BERLIN, now: NOW },
    ).body;
    expect(property(body, "SUMMARY")).toBe("Line one\\nEND:VEVENT");
    expect(contentLines(body).filter((l) => l === "END:VEVENT")).toHaveLength(1);
  });

  it("exports an all-day event without an end as one day, across DST as whole days", () => {
    const oneDay = buildIcs(
      { ...EVENT, allDay: true, start: "2026-06-25T22:00:00.000Z", end: null },
      { tz: BERLIN, now: NOW },
    ).body;
    expect(contentLines(oneDay)).toEqual(
      expect.arrayContaining(["DTSTART;VALUE=DATE:20260626", "DTEND;VALUE=DATE:20260627"]),
    );
    const acrossDst = buildIcs(
      {
        ...EVENT,
        allDay: true,
        start: "2026-10-23T22:00:00.000Z",
        end: "2026-10-25T23:00:00.000Z",
      },
      { tz: BERLIN, now: NOW },
    ).body;
    expect(contentLines(acrossDst)).toEqual(
      expect.arrayContaining(["DTSTART;VALUE=DATE:20261024", "DTEND;VALUE=DATE:20261027"]),
    );
  });

  it("exports a timed event without an end with DTEND = DTSTART", () => {
    const body = buildIcs({ ...EVENT, end: undefined }, { tz: BERLIN, now: NOW }).body;
    expect(property(body, "DTSTART")).toBe("20261001T100000Z");
    expect(property(body, "DTEND")).toBe("20261001T100000Z");
  });
});
