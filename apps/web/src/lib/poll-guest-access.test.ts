import { describe, expect, it } from "vitest";
import { NO_GUEST_ACCESS, normalizeGuestAccess } from "./poll-guest-access";

/**
 * Guest access of a new poll (owner decision 2026-09-27): hidden from
 * guests by default, guest voting only together with visibility, strict
 * booleans only. The create form runs every checkbox change through
 * normalizeGuestAccess (that is how unchecking "Visible to guests" clears
 * "Guests can vote"), and the create action sends its result.
 */
describe("normalizeGuestAccess", () => {
  it("starts hidden from guests", () => {
    expect(NO_GUEST_ACCESS).toEqual({ visibleToGuests: false, guestsCanVote: false });
    expect(normalizeGuestAccess({})).toEqual(NO_GUEST_ACCESS);
  });

  it("keeps visibility with or without guest voting", () => {
    expect(normalizeGuestAccess({ visibleToGuests: true, guestsCanVote: false })).toEqual({
      visibleToGuests: true,
      guestsCanVote: false,
    });
    expect(normalizeGuestAccess({ visibleToGuests: true, guestsCanVote: true })).toEqual({
      visibleToGuests: true,
      guestsCanVote: true,
    });
  });

  it("clears guest voting whenever the poll is not visible to guests", () => {
    for (const visibleToGuests of [false, undefined, null]) {
      expect(
        normalizeGuestAccess({ visibleToGuests, guestsCanVote: true }),
        String(visibleToGuests),
      ).toEqual(NO_GUEST_ACCESS);
    }
  });

  it("models the form: unchecking visibility clears the vote switch", () => {
    let state = normalizeGuestAccess({ ...NO_GUEST_ACCESS, visibleToGuests: true });
    state = normalizeGuestAccess({ ...state, guestsCanVote: true });
    expect(state).toEqual({ visibleToGuests: true, guestsCanVote: true });
    state = normalizeGuestAccess({ ...state, visibleToGuests: false });
    expect(state).toEqual(NO_GUEST_ACCESS);
    // Checking visibility again does not bring the vote switch back.
    state = normalizeGuestAccess({ ...state, visibleToGuests: true });
    expect(state).toEqual({ visibleToGuests: true, guestsCanVote: false });
  });

  it("accepts only a real true (no truthy strings or numbers from a crafted call)", () => {
    for (const value of ["true", "on", 1, {}, []] as unknown[]) {
      expect(
        normalizeGuestAccess({ visibleToGuests: value, guestsCanVote: value }),
        JSON.stringify(value),
      ).toEqual(NO_GUEST_ACCESS);
    }
  });
});
