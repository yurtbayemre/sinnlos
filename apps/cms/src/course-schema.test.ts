import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** All modes use server grading; only the amount of feedback differs. */
const schema = JSON.parse(
  readFileSync(join(__dirname, "api", "course", "content-types", "course", "schema.json"), "utf8"),
) as {
  info: { description: string };
  attributes: Record<string, Record<string, unknown>>;
};

describe("Course schema: completionMode", () => {
  it("describes the mode as the quiz's feedback, with correct answers required in every mode", () => {
    const { description } = schema.info;
    expect(description).not.toContain("Abschluss per Klick");
    expect(description).toContain("completionMode waehlt nur das Feedback des Quiz");
    expect(description).toContain("confirm = Rueckmeldung pro Antwort");
    expect(description).toContain("quizGate = eine Pruefung per 'Antworten pruefen'");
    expect(description).toContain(
      "In allen Modi schliesst eine Lektion mit Quiz erst ab, wenn alle Antworten richtig sind",
    );
    expect(description).toContain("eine Lektion ohne Quiz per Klick");
    expect(description).toContain("exam = nur Gesamtergebnis");
    expect(description).toContain("keine Loesungsschluessel");
  });

  it("adds exam feedback without changing the default", () => {
    expect(schema.attributes.completionMode).toEqual({
      type: "enumeration",
      enum: ["confirm", "quizGate", "exam"],
      default: "confirm",
    });
  });
});
