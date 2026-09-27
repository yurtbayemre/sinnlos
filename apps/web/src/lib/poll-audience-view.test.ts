import { describe, expect, it } from "vitest";
import { pollAudienceView } from "./poll-audience-view";

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
        audience: { targeted: true, departments: [{ documentId: "d1", name: "Engineering" }, { documentId: "d2", name: "Design" }] },
      }),
    ).toEqual({ canVote: true, targeted: true, departmentNames: ["Engineering", "Design"], hint: null });
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
    ).toMatchObject({ canVote: false, targeted: true, departmentNames: [], hint: "audienceMissing" });
  });

  it("leaves a company-wide poll without badge or hint", () => {
    expect(
      pollAudienceView({ canVote: true, audience: { targeted: false, departments: [] } }),
    ).toEqual({ canVote: true, targeted: false, departmentNames: [], hint: null });
  });
});
