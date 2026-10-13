import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MANAGE_MESSAGE_AREAS, withManageMessages } from "./messages";

/**
 * en.json and de.json must carry the same keys (README "Internationalization":
 * new user-visible strings go into both files). next-intl throws
 * MISSING_MESSAGE at render time for a key one locale lacks, so a gap only
 * shows up on a page in that language. The same holds for every /manage area
 * file, messages/manage/<area>.<locale>.json (decision 06 §L7), which
 * i18n/messages.ts merges under `manage.<area>`.
 */

type Messages = { [key: string]: string | Messages };

const MESSAGES_DIR = join(__dirname, "..", "..", "messages");

const load = (locale: string): Messages =>
  JSON.parse(readFileSync(join(MESSAGES_DIR, `${locale}.json`), "utf8")) as Messages;

const loadManage = (area: string, locale: string): Messages =>
  JSON.parse(
    readFileSync(join(MESSAGES_DIR, "manage", `${area}.${locale}.json`), "utf8"),
  ) as Messages;

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

describe("the /manage message files (decision 06 §L7)", () => {
  it("are exactly the merged areas, each in en and de", () => {
    const files = readdirSync(join(MESSAGES_DIR, "manage")).sort();
    expect(files).toEqual(
      MANAGE_MESSAGE_AREAS.flatMap((area) => [`${area}.de.json`, `${area}.en.json`]).sort(),
    );
  });

  it.each(MANAGE_MESSAGE_AREAS)("%s has the same keys and ICU arguments in en and de", (area) => {
    const en = loadManage(area, "en");
    const de = loadManage(area, "de");
    expect(keyPaths(de).sort()).toEqual(keyPaths(en).sort());
    const mismatched = keyPaths(en).filter(
      (path) =>
        JSON.stringify(argumentsOf(lookup(en, path))) !==
        JSON.stringify(argumentsOf(lookup(de, path))),
    );
    expect(mismatched).toEqual([]);
    // No empty text: a missing translation must not render blank.
    expect(keyPaths(de).filter((path) => lookup(de, path).trim() === "")).toEqual([]);
    expect(keyPaths(en).filter((path) => lookup(en, path).trim() === "")).toEqual([]);
  });

  it("leave the `manage` namespace to the area files (the base catalogs have none)", () => {
    expect(Object.hasOwn(load("en"), "manage")).toBe(false);
    expect(Object.hasOwn(load("de"), "manage")).toBe(false);
    expect(() => withManageMessages({ manage: {} }, {} as never)).toThrow(/manage/);
  });

  it("merge under manage.<area> without touching the base keys", () => {
    const en = load("en");
    const areas = Object.fromEntries(
      MANAGE_MESSAGE_AREAS.map((area) => [area, loadManage(area, "en")]),
    ) as Record<(typeof MANAGE_MESSAGE_AREAS)[number], Messages>;
    const merged = withManageMessages(en, areas);
    expect(Object.keys(merged).sort()).toEqual([...Object.keys(en), "manage"].sort());
    expect(merged.manage.common).toBe(areas.common);
  });

  it("carry the department-author texts in manage/common (§L7)", () => {
    for (const locale of ["en", "de"]) {
      const common = loadManage("common", locale);
      for (const key of [
        "departmentAuthor.department",
        "departmentAuthor.eventVisibility",
        "departmentAuthor.noDepartmentTitle",
        "departmentAuthor.noDepartmentHint",
        "status.department",
        "status.needsRetarget",
        "errors.neverPublished",
      ]) {
        expect(lookup(common, key), `${locale} ${key}`).toBeTruthy();
      }
    }
  });
});
