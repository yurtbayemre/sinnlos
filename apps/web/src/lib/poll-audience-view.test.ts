import { describe, expect, it } from "vitest";
import { pollAudienceView, pollGuestNotes } from "./poll-audience-view";

/**
 * The card's reading of the CMS results (decision 02): the web never
 * decides eligibility itself, it only renders `canVote` and `audience`.
 */
describe("pollAudienceView", () => {
  it("keeps voting open when an older CMS sends neither field", () => {
    expect(pollAudienceView({})).toEqual({
      canVote: true,
      targeted: false,
      departmentNames: [],
      hint: null,
    });
  });

  it("shows the targeted departments to a member of the audience", () => {
    expect(
      pollAudienceView({
        canVote: true,
        audience: {
          targeted: true,
          departments: [
            { documentId: "d1", name: "Engineering" },
            { documentId: "d2", name: "Design" },
          ],
        },
      }),
    ).toEqual({
      canVote: true,
      targeted: true,
      departmentNames: ["Engineering", "Design"],
      hint: null,
    });
  });

  it("locks voting with the notInAudience hint when the CMS says canVote false", () => {
    expect(
      pollAudienceView({
        canVote: false,
        audience: { targeted: true, departments: [{ documentId: "d1", name: "Engineering" }] },
      }),
    ).toMatchObject({ canVote: false, hint: "notInAudience" });
  });

  it("says audienceMissing for a targeted poll without departments", () => {
    expect(
      pollAudienceView({ canVote: false, audience: { targeted: true, departments: [] } }),
    ).toMatchObject({
      canVote: false,
      targeted: true,
      departmentNames: [],
      hint: "audienceMissing",
    });
  });

  it("leaves a company-wide poll without badge or hint", () => {
    expect(
      pollAudienceView({ canVote: true, audience: { targeted: false, departments: [] } }),
    ).toEqual({ canVote: true, targeted: false, departmentNames: [], hint: null });
  });

  it("says guestVotingDisabled to a guest the CMS does not let vote (owner decision 2026-09-27)", () => {
    for (const audience of [
      { targeted: false, departments: [] },
      { targeted: true, departments: [{ documentId: "d1", name: "Engineering" }] },
    ]) {
      expect(pollAudienceView({ canVote: false, audience }, { viewerIsGuest: true })).toMatchObject(
        {
          canVote: false,
          hint: "guestVotingDisabled",
        },
      );
    }
  });

  it("gives a guest who may vote no hint, and a non-guest the audience hint as before", () => {
    const audience = { targeted: false, departments: [] };
    expect(pollAudienceView({ canVote: true, audience }, { viewerIsGuest: true }).hint).toBeNull();
    expect(pollAudienceView({ canVote: false, audience }, { viewerIsGuest: false }).hint).toBe(
      "notInAudience",
    );
    expect(pollAudienceView({ canVote: false, audience }).hint).toBe("notInAudience");
  });
});

describe("pollGuestNotes", () => {
  const poll = { id: 1, question: "q", options: ["a", "b"] };

  it("names the guest access a poll has in effect", () => {
    expect(pollGuestNotes({ ...poll, visibleToGuests: true, guestsCanVote: true })).toEqual([
      "guestAccessVisible",
      "guestAccessVote",
    ]);
    expect(pollGuestNotes({ ...poll, visibleToGuests: true, guestsCanVote: false })).toEqual([
      "guestAccessVisible",
    ]);
  });

  it("has no note for a poll hidden from guests, an inert vote flag or an older CMS", () => {
    expect(pollGuestNotes({ ...poll, visibleToGuests: false, guestsCanVote: false })).toEqual([]);
    expect(pollGuestNotes({ ...poll, visibleToGuests: false, guestsCanVote: true })).toEqual([]);
    expect(pollGuestNotes(poll)).toEqual([]);
  });
});
