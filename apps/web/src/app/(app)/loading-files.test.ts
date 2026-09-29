import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { RouteProgress } from "@/components/route-progress";
import * as skeletons from "@/components/skeletons";

/**
 * UI05, architecture §5.13: every page of the app has its own loading.tsx,
 * which renders or re-exports a shared skeleton of components/skeletons.tsx
 * (with the RouteProgress bar), so a navigation shows a content-shaped
 * placeholder instead of the parent's, and no route hand-rolls one with a
 * width that overflows a phone (the former training skeletons used w-96).
 */
const APP = join(__dirname);

function pageDirectories(dir: string): string[] {
  const found = existsSync(join(dir, "page.tsx")) ? [dir] : [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...pageDirectories(join(dir, entry.name)));
  }
  return found;
}

const PAGES = pageDirectories(APP).map((dir) => relative(APP, dir) || ".");

/** Every element in a rendered skeleton tree (through children). */
function elements(node: ReactNode): unknown[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node.type, ...elements(node.props.children)];
}

describe("loading.tsx per page", () => {
  it("finds the pages", () => {
    expect(PAGES).toContain(".");
    expect(PAGES).toContain(join("manage", "training"));
    expect(PAGES).toContain(join("polls", "new"));
    expect(PAGES.length).toBeGreaterThan(25);
  });

  it.each(PAGES)("%s has a loading.tsx built on the shared skeletons", (page) => {
    const file = join(APP, page, "loading.tsx");
    expect(existsSync(file), file).toBe(true);
    const source = readFileSync(file, "utf8");
    expect(source).toContain('from "@/components/skeletons"');
    expect(source).not.toMatch(/\bw-96\b/);
  });
});

describe("the shared page skeletons", () => {
  const PAGE_SKELETONS = Object.entries(skeletons).filter(([name]) =>
    /(Page|Dashboard|Course|CourseList|Lesson|Manage|Article|FormPage|ListPage|DetailPage)Skeleton$/.test(
      name,
    ),
  );

  it.each(PAGE_SKELETONS)("%s starts the RouteProgress bar", (_name, Skeleton) => {
    const tree = elements((Skeleton as (props: object) => ReactNode)({}));
    expect(tree).toContain(RouteProgress);
  });

  it("keep wide fixed widths inside the viewport", () => {
    const source = readFileSync(join(APP, "..", "..", "components", "skeletons.tsx"), "utf8");
    expect(source).not.toMatch(/\bw-96\b/);
    for (const match of source.matchAll(/className="([^"]*\bw-(?:80|72)\b[^"]*)"/g)) {
      expect(match[1], match[1]).toContain("max-w-full");
    }
  });
});
