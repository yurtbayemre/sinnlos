import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
import type { CommentSectionData } from "@/lib/reaction-summary";
import type { Comment } from "@/lib/types";

/**
 * SH02 / FX28 (hide controls): a comment section offers only what the
 * viewer's role may do. The comment form needs comment create, the reaction
 * bar reaction create, the delete button on one's own comments comment
 * delete; guest holds none of them, the `authenticated` fallback no delete.
 * The server entry (CommentSection) decides from getViewer().role, the
 * client section renders accordingly. The actions, the session and the
 * viewer are mocked; the markup uses the real English catalog.
 */
const viewer = vi.hoisted(() => ({ role: "member" as string | null }));

vi.mock("@/lib/comment-actions", () => ({
  addComment: vi.fn(),
  deleteComment: vi.fn(),
  toggleReaction: vi.fn(),
  getCommentSection: vi.fn(),
  getCommentSections: vi.fn(async () => []),
}));
vi.mock("@/lib/session", () => ({ getSession: async () => ({ user: { id: 7 } }) }));
vi.mock("@/lib/viewer", () => ({
  getViewer: async () => ({ id: 7, displayName: "V", role: viewer.role, department: null }),
}));

const { CommentSection, commentControlsFor } = await import("./comment-section");
const { LiveCommentSection } = await import("./live-comment-section");
type Controls = Parameters<typeof LiveCommentSection>[0]["controls"];

const target = { type: "announcement" as const, documentId: "k3m9x0000000000000000000" };
const own: Comment = {
  id: 1,
  body: "Mine",
  targetType: "announcement",
  targetDocumentId: target.documentId,
  author: { id: 7, username: "me", displayName: "Me" },
  createdAt: "2026-09-29T08:00:00.000Z",
} as Comment;
const data: CommentSectionData = { comments: [own], reactions: [] };

const render = (controls: Controls) =>
  renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- a .test.ts has no JSX, and createElement's types want the provider's required children in the props
    createElement(NextIntlClientProvider, {
      locale: "en",
      messages: en,
      timeZone: "Europe/Berlin",
      children: createElement(LiveCommentSection, {
        target,
        currentUserId: 7,
        initial: data,
        controls,
      }),
    }),
  );

beforeEach(() => {
  viewer.role = "member";
});

describe("commentControlsFor", () => {
  it.each([
    ["admin_role", { comment: true, react: true, deleteOwn: true }],
    ["member", { comment: true, react: true, deleteOwn: true }],
    ["authenticated", { comment: true, react: true, deleteOwn: false }],
    ["guest", { comment: false, react: false, deleteOwn: false }],
    [null, { comment: false, react: false, deleteOwn: false }],
    ["Member", { comment: false, react: false, deleteOwn: false }],
  ])("%s", (role, expected) => {
    expect(commentControlsFor(role)).toEqual(expected);
  });
});

describe("CommentSection hands the viewer's controls to the client section", () => {
  it.each(["member", "guest", "authenticated", null])("%s", async (role) => {
    viewer.role = role;
    const element = (await CommentSection({
      target,
      sections: Promise.resolve(new Map([[`announcement:${target.documentId}`, data]])),
    })) as ReactElement<{ controls: Controls; initial: CommentSectionData }>;
    expect(isValidElement(element)).toBe(true);
    expect(element.props.controls).toEqual(commentControlsFor(role));
    expect(element.props.initial).toBe(data);
  });
});

describe("LiveCommentSection", () => {
  const form = `placeholder="${en.comments.writeComment}"`;
  const deleteButton = `aria-label="${en.comments.deleteComment}"`;
  const reactionBar = 'aria-pressed="false"';

  it("offers the form, the reaction bar and the own delete with every control", () => {
    const html = render({ comment: true, react: true, deleteOwn: true });
    expect(html).toContain(form);
    expect(html).toContain(reactionBar);
    expect(html).toContain(deleteButton);
    expect(html).toContain("Mine");
  });

  it("reads the thread only without controls (guest)", () => {
    const html = render({ comment: false, react: false, deleteOwn: false });
    expect(html).not.toContain(form);
    expect(html).not.toContain("<form");
    expect(html).not.toContain(reactionBar);
    expect(html).not.toContain(deleteButton);
    expect(html).toContain("Mine");
  });

  it("keeps the form but drops the own delete without comment delete (authenticated)", () => {
    const html = render({ comment: true, react: true, deleteOwn: false });
    expect(html).toContain(form);
    expect(html).toContain(reactionBar);
    expect(html).not.toContain(deleteButton);
  });
});
