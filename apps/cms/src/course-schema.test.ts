import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The Course schema's description (the admin shows it in the Content-Type
 * Builder) says what completionMode does since issue #70 (batch 16.1): the
 * mode picks the quiz's feedback only (confirm: per answer; quizGate: one
 * "Antworten prüfen"), and in both modes a lesson with a quiz completes only
 * with every answer correct (lesson-progress create checks the answers with
 * quizAnswersPass). It used to say "confirm = Abschluss per Klick".
 *
 * The description is `info`, which Strapi leaves out of the database model
 * (strapi_database_schema holds tables, columns and indexes only): a
 * description-only edit changes no table and runs no schema sync. The
 * completionMode attribute is pinned here as it was.
 */
const schema = JSON.parse(
  readFileSync(join(__dirname, "api", "course", "content-types", "course", "schema.json"), "utf8"),
) as {
  info: { description: string };
  attributes: Record<string, Record<string, unknown>>;
};

describe("Course schema: completionMode", () => {
  it("describes the mode as the quiz's feedback, with correct answers required in both", () => {
    const { description } = schema.info;
    expect(description).not.toContain("Abschluss per Klick");
    expect(description).toContain("completionMode waehlt nur das Feedback des Quiz");
    expect(description).toContain("confirm = Rueckmeldung pro Antwort");
    expect(description).toContain("quizGate = eine Pruefung per 'Antworten pruefen'");
    expect(description).toContain(
      "In beiden Modi schliesst eine Lektion mit Quiz erst ab, wenn alle Antworten richtig sind",
    );
    expect(description).toContain("eine Lektion ohne Quiz per Klick");
  });

  it("keeps the attribute itself as it was (the enum, the default)", () => {
    expect(schema.attributes.completionMode).toEqual({
      type: "enumeration",
      enum: ["confirm", "quizGate"],
      default: "confirm",
    });
  });
});
