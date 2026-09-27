import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * en.json and de.json must carry the same keys (README "Internationalization":
 * new user-visible strings go into both files). next-intl throws
 * MISSING_MESSAGE at render time for a key one locale lacks, so a gap only
 * shows up on a page in that language.
 */

type Messages = { [key: string]: string | Messages };

const MESSAGES_DIR = join(__dirname, "..", "..", "messages");

const load = (locale: string): Messages =>
  JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}.json`), "utf8")) as Messages;

function keyPaths(messages: Messages, prefix = ""): string[] {
  return Object.entries(messages).flatMap(([key, value]) =>
    typeof value === "string" ? [`${prefix}${key}`] : keyPaths(value, `${prefix}${key}.`),
  );
}

/**
 * Top-level ICU arguments of a message: `{name}` and `{name, plural, ...}`.
 * Braces nested inside an argument (plural/select branches such as
 * `one {# vote}`) are translated text, not arguments.
 */
function argumentsOf(text: string): string[] {
  const names: string[] = [];
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (depth === 0) {
        const name = /^\{\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i))?.[1];
        if (name) names.push(name);
      }
      depth++;
    } else if (text[i] === "}") {
      depth = Math.max(0, depth - 1);
    }
  }
  return names.sort();
}

function lookup(messages: Messages, path: string): string {
  let node: string | Messages = messages;
  for (const part of path.split(".")) node = (node as Messages)[part];
  return node as string;
}

describe("message catalogs", () => {
  const en = load("en");
  const de = load("de");

  it("have the same keys in en and de", () => {
    expect(keyPaths(de).sort()).toEqual(keyPaths(en).sort());
  });

  it("use the same ICU arguments per key", () => {
    const mismatched = keyPaths(en).filter(
      (path) =>
        JSON.stringify(argumentsOf(lookup(en, path))) !==
        JSON.stringify(argumentsOf(lookup(de, path))),
    );
    expect(mismatched).toEqual([]);
  });

  it("carry the poll targeting copy (decision 02)", () => {
    for (const key of [
      "formDepartments",
      "formDepartmentsHint",
      "audienceDepartments",
      "notInAudience",
      "audienceMissing",
      "departmentsUnavailable",
    ]) {
      expect(lookup(en, `polls.${key}`), key).toBeTruthy();
      expect(lookup(de, `polls.${key}`), key).toBeTruthy();
    }
    expect(argumentsOf(lookup(en, "polls.audienceDepartments"))).toEqual(["departments"]);
  });
});
