import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";
import { StrapiError } from "@/lib/strapi-error";

/**
 * The training report CSV downloads (v0.20). Pinned: an unknown kind or a
 * malformed course id is refused before anything is read; the capability is
 * checked server-side; the cms read is the scoped report (its 404 stays a
 * 404); the file is a no-store attachment with a dated name.
 */
const state = vi.hoisted(() => ({ role: "department_head", report: vi.fn() }));
vi.mock("@/lib/viewer", () => ({ getViewer: async () => ({ role: state.role }) }));
vi.mock("@/lib/api/training", () => ({ courseTrainingReport: state.report }));
vi.mock("@/lib/app-time-zone", () => ({ appTimeZone: () => "Europe/Berlin" }));

const { GET } = await import("./route");

const DOC = "k3v9q2m8x7c4b1n6p5z0r2t8";

function get(kind: string | null, course = DOC) {
  const query = kind === null ? "" : `?kind=${kind}`;
  return GET(new NextRequest(`http://web.test/manage/training/report/${course}/export${query}`), {
    params: Promise.resolve({ course }),
  });
}

beforeEach(() => {
  state.role = "department_head";
  state.report.mockReset().mockResolvedValue({
    data: {
      scope: "department",
      department: "Lager",
      course: {
        documentId: DOC,
        title: "Stapler",
        slug: "stapler",
        validityMonths: 12,
        lessonCount: 1,
        departments: ["Lager"],
        counts: { done: 0, dueSoon: 0, expired: 0, open: 1, total: 1 },
      },
      lessons: [{ documentId: "a".repeat(24), title: "Sicherheit" }],
      people: [
        {
          userId: 1,
          name: "Ana",
          email: null,
          department: "Lager",
          status: "open",
          completed: 0,
          total: 1,
          completedAt: null,
          dueKey: null,
          receipts: [],
        },
      ],
    },
  });
});

it("answers the status CSV as a dated, uncached attachment", async () => {
  const res = await get("status");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("content-disposition")).toMatch(
    /^attachment; filename="unterweisung-stapler-status-\d{4}-\d{2}-\d{2}\.csv"$/,
  );
  // The BOM is the response's first character (no decoding that strips it).
  const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
  expect(body.startsWith("\uFEFFName;E-Mail;Abteilung;Status")).toBe(true);
  expect(body).toContain("Ana;;Lager;Offen;0/1;;");
  expect(state.report).toHaveBeenCalledWith(DOC);
});

it("answers the proof CSV under its own name", async () => {
  const res = await get("receipts");
  expect(res.headers.get("content-disposition")).toContain("unterweisung-stapler-nachweis-");
});

it("refuses an unknown kind or a malformed id before any read", async () => {
  expect((await get(null)).status).toBe(400);
  expect((await get("all")).status).toBe(400);
  expect((await get("status", "../x")).status).toBe(404);
  expect(state.report).not.toHaveBeenCalled();
});

it("refuses roles without the report", async () => {
  for (const role of ["editor", "member", "guest", null]) {
    state.role = role as string;
    expect((await get("status")).status, String(role)).toBe(403);
  }
  expect(state.report).not.toHaveBeenCalled();
});

it("keeps the cms's 404 and turns other failures into 502", async () => {
  state.report.mockRejectedValueOnce(new StrapiError(404, "Not Found", ""));
  expect((await get("status")).status).toBe(404);
  state.report.mockRejectedValueOnce(new Error("offline"));
  expect((await get("status")).status).toBe(502);
});
