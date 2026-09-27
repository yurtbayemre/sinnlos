import { describe, expect, it } from "vitest";
import { parseEntryRef } from "./entry-id";
import { icsHref } from "./event-ics";

/**
 * The events page links the ICS download by documentId (EVT-ICS-ID): it
 * survives a re-publish, which gives the published row a new numeric id.
 */
const DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";

describe("icsHref", () => {
  it("links the documentId", () => {
    expect(icsHref({ id: 12, documentId: DOC })).toBe(`/events/${DOC}/ics`);
  });

  it("falls back to the numeric id without a documentId", () => {
    expect(icsHref({ id: 12 })).toBe("/events/12/ics");
    expect(icsHref({ id: 12, documentId: "" })).toBe("/events/12/ics");
  });

  it("encodes the path segment", () => {
    expect(icsHref({ id: 1, documentId: "a/b?c#d" })).toBe("/events/a%2Fb%3Fc%23d/ics");
  });

  it("produces a link the ICS route accepts for a Strapi entry", () => {
    const segment = icsHref({ id: 3, documentId: DOC }).split("/")[2];
    expect(parseEntryRef(segment)).toEqual({ documentId: DOC });
  });
});
