import { redirect } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AD_DEFAULT_DURATION_DAYS, MAX_AD_IMAGE_BYTES, dateInDays } from "@/lib/classified-shared";
import { StrapiError } from "@/lib/strapi-error";

/**
 * Marketplace action characterisation (S09), through the exported actions:
 *   - parseAdForm's machine codes and value replay, via create/update;
 *   - the two-step write: multipart upload (raw fetch with the caller's JWT),
 *     then the ad; a failed ad write sweeps the JUST-uploaded ids, an update
 *     sweeps the deselected ids only AFTER the PUT landed, and a cleanup
 *     failure is swallowed (the cms janitor is the net);
 *   - strapi()'s 401 sign-in redirect (NEXT_REDIRECT) propagates from every
 *     strapi() call, before any cleanup; the success redirect is a real
 *     NEXT_REDIRECT too, after refresh().
 * strapi(), the session, config and next/cache are mocked, fetch is stubbed;
 * next/navigation is the real one.
 */

const strapiMock = vi.fn();
const refreshMock = vi.fn();
const tokenMock = vi.fn<() => Promise<string | null>>();
const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<Response>>();

vi.mock("@/lib/strapi", () => ({ strapi: (...args: unknown[]) => strapiMock(...args) }));
vi.mock("@/lib/session", () => ({ getStrapiToken: () => tokenMock() }));
vi.mock("@/lib/config", () => ({ DEMO_MODE: false, STRAPI_URL: "http://cms.test" }));
vi.mock("next/cache", () => ({ refresh: () => refreshMock() }));
vi.stubGlobal("fetch", fetchMock);

const { createClassified, deleteClassified, renewClassified, updateClassified } = await import("./classified-actions");

const NOW = new Date("2026-09-28T10:00:00.000Z");

function signInRedirect(): unknown {
  try {
    redirect("/sign-in?expired=1");
  } catch (error) {
    return error;
  }
  throw new Error("redirect() did not throw");
}

const digestOf = (error: unknown) => String((error as { digest?: unknown }).digest);

const cmsError = (status: number) => new StrapiError(status, "Error", JSON.stringify({ error: { status } }));

const image = (name: string, type = "image/jpeg", size = 16) => new File([new Uint8Array(size)], name, { type });

interface FormInput {
  title?: string;
  description?: string;
  category?: string;
  price?: string;
  priceNegotiable?: boolean;
  location?: string;
  days?: string;
  images?: File[];
  keepImages?: string[];
}

function form(input: FormInput = {}): FormData {
  const data = new FormData();
  data.set("title", input.title ?? "Bike");
  data.set("description", input.description ?? "Barely used");
  data.set("category", input.category ?? "sale");
  data.set("price", input.price ?? "");
  if (input.priceNegotiable) data.set("priceNegotiable", "on");
  data.set("location", input.location ?? "");
  data.set("days", input.days ?? "");
  for (const file of input.images ?? []) data.append("images", file);
  for (const id of input.keepImages ?? []) data.append("keepImages", id);
  return data;
}

/** [path, method, parsed body] of every strapi() call, in order. */
const strapiCalls = () =>
  strapiMock.mock.calls.map((call) => {
    const [path, init] = call as [string, { method?: string; body?: string } | undefined];
    return [path, init?.method ?? "GET", init?.body ? (JSON.parse(init.body) as unknown) : undefined] as const;
  });

const uploadAnswers = (ids: number[]) =>
  new Response(JSON.stringify(ids.map((id) => ({ id }))), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  strapiMock.mockReset();
  strapiMock.mockResolvedValue({ data: {} });
  refreshMock.mockReset();
  tokenMock.mockReset();
  tokenMock.mockResolvedValue("jwt-1");
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(uploadAnswers([11, 12]));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createClassified: form parsing (parseAdForm)", () => {
  it.each<[string, FormInput, string]>([
    ["no title", { title: "" }, "missingFields"],
    ["a blank title", { title: "   " }, "missingFields"],
    ["no description", { description: "" }, "missingFields"],
    ["an unknown category", { category: "cars" }, "missingFields"],
    ["a negative price", { price: "-1" }, "invalidPrice"],
    ["a non-numeric price", { price: "abc" }, "invalidPrice"],
    ["an infinite price", { price: "Infinity" }, "invalidPrice"],
    ["five images", { images: [image("1.jpg"), image("2.jpg"), image("3.jpg"), image("4.jpg"), image("5.jpg")] }, "imageCount"],
    ["new plus kept images over four", { images: [image("1.jpg"), image("2.jpg")], keepImages: ["7", "8", "9"] }, "imageCount"],
    ["a gif", { images: [image("a.gif", "image/gif")] }, "imageType"],
    ["an image over 5 MB", { images: [image("big.jpg", "image/jpeg", MAX_AD_IMAGE_BYTES + 1)] }, "imageSize"],
  ])("answers %s with its code, replays the values and sends nothing", async (_label, input, code) => {
    const result = await createClassified({}, form(input));
    expect(result.error).toBe(code);
    expect(result.values).toEqual({
      title: input.title ?? "Bike",
      description: input.description ?? "Barely used",
      category: input.category ?? "sale",
      price: input.price ?? "",
      priceNegotiable: false,
      location: "",
      days: "",
    });
    expect(strapiMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<[string, string, number | null]>([
    ["empty", "", null],
    ["a comma decimal", "12,5", 12.5],
    ["padding", " 7 ", 7],
    ["three decimals, rounded to cents", "12.349", 12.35],
    ["an exponent", "1e3", 1000],
    ["zero", "0", 0],
  ])("parses %s as price %s", async (_label, price, expected) => {
    await expect(createClassified({}, form({ price }))).rejects.toThrow("NEXT_REDIRECT");
    const [, , body] = strapiCalls()[0];
    expect((body as { data: { price: unknown } }).data.price).toBe(expected);
  });

  it.each<[string, string, number]>([
    ["no lifetime", "", AD_DEFAULT_DURATION_DAYS],
    ["14 days", "14", 14],
    ["zero", "0", AD_DEFAULT_DURATION_DAYS],
    ["a fraction", "1.5", AD_DEFAULT_DURATION_DAYS],
    ["text", "soon", AD_DEFAULT_DURATION_DAYS],
  ])("expires after %s", async (_label, days, expected) => {
    await expect(createClassified({}, form({ days }))).rejects.toThrow("NEXT_REDIRECT");
    const [, , body] = strapiCalls()[0];
    expect((body as { data: { expiresAt: unknown } }).data.expiresAt).toBe(dateInDays(expected));
  });

  it("ignores empty file inputs and malformed kept ids", async () => {
    const empty = new File([], "", { type: "application/octet-stream" });
    await expect(
      updateClassified(5, {}, form({ images: [empty], keepImages: ["3", "-1", "x", "2.5", "4"] })),
    ).rejects.toThrow("NEXT_REDIRECT");
    expect(fetchMock).not.toHaveBeenCalled();
    const put = strapiCalls().find(([, method]) => method === "PUT");
    expect((put?.[2] as { data: { images: unknown } }).data.images).toEqual([3, 4]);
  });
});

describe("createClassified: the two-step write", () => {
  it("posts the ad with trimmed fields, refreshes, then redirects to /marketplace", async () => {
    const order: string[] = [];
    refreshMock.mockImplementation(() => order.push("refresh"));
    const error = await createClassified(
      {},
      form({ title: " Bike ", description: " Red ", price: "20", priceNegotiable: true, location: " HQ ", days: "7" }),
    ).catch((caught: unknown) => caught);
    order.push("redirect");
    expect(digestOf(error)).toContain("NEXT_REDIRECT");
    expect(digestOf(error)).toContain("/marketplace");
    expect(order).toEqual(["refresh", "redirect"]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(strapiCalls()).toEqual([
      [
        "/api/classifieds",
        "POST",
        {
          data: {
            title: "Bike",
            description: "Red",
            category: "sale",
            price: 20,
            priceNegotiable: true,
            location: "HQ",
            images: [],
            expiresAt: dateInDays(7),
          },
        },
      ],
    ]);
  });

  it("uploads the images first, with the caller's JWT, and posts their ids", async () => {
    await expect(createClassified({}, form({ images: [image("a.jpg"), image("b.png", "image/png")] }))).rejects.toThrow(
      "NEXT_REDIRECT",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://cms.test/api/upload");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer jwt-1");
    expect((init.body as FormData).getAll("files")).toHaveLength(2);
    expect(init.cache).toBe("no-store");
    expect((strapiCalls()[0][2] as { data: { images: unknown } }).data.images).toEqual([11, 12]);
  });

  it("sweeps the just-uploaded ids AFTER a failed ad write, and answers 'failed' with the values", async () => {
    strapiMock.mockRejectedValueOnce(cmsError(400));
    const result = await createClassified({}, form({ images: [image("a.jpg")] }));
    expect(result).toMatchObject({ error: "failed", values: { title: "Bike" } });
    expect(strapiCalls().map(([path, method, body]) => [path, method, body])).toEqual([
      ["/api/classifieds", "POST", expect.anything()],
      ["/api/classifieds/cleanup-uploads", "POST", { imageIds: [11, 12] }],
    ]);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("does not sweep when the upload itself failed (nothing was stored)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("too large", { status: 413 }));
    await expect(createClassified({}, form({ images: [image("a.jpg")] }))).resolves.toMatchObject({ error: "failed" });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("fails without a Strapi JWT before uploading", async () => {
    tokenMock.mockResolvedValueOnce(null);
    await expect(createClassified({}, form({ images: [image("a.jpg")] }))).resolves.toMatchObject({ error: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("swallows a failing sweep: the answer stays 'failed'", async () => {
    strapiMock.mockRejectedValueOnce(cmsError(400)).mockRejectedValueOnce(cmsError(500));
    await expect(createClassified({}, form({ images: [image("a.jpg")] }))).resolves.toMatchObject({ error: "failed" });
    expect(strapiMock).toHaveBeenCalledTimes(2);
  });

  it("lets a 401 redirect from the ad write propagate, before any sweep", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValueOnce(redirectError);
    await expect(createClassified({}, form({ images: [image("a.jpg")] }))).rejects.toBe(redirectError);
    expect(strapiCalls().map(([path]) => path)).toEqual(["/api/classifieds"]);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("lets a 401 redirect from the sweep propagate", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValueOnce(cmsError(400)).mockRejectedValueOnce(redirectError);
    await expect(createClassified({}, form({ images: [image("a.jpg")] }))).rejects.toBe(redirectError);
  });
});

describe("updateClassified", () => {
  beforeEach(() => {
    // The ad currently holds images 3, 4 and 5.
    strapiMock.mockImplementation(async (path: string) =>
      path.startsWith("/api/classifieds?") ? { data: [{ images: [{ id: 3 }, { id: 4 }, { id: 5 }] }] } : { data: {} },
    );
  });

  it("reads the current images, PUTs kept + new ids, THEN sweeps the deselected ones, refreshes and redirects", async () => {
    const error = await updateClassified(
      9,
      {},
      form({ images: [image("new.jpg")], keepImages: ["3"], days: "30" }),
    ).catch((caught: unknown) => caught);
    expect(digestOf(error)).toContain("/marketplace/9");
    expect(strapiCalls()).toEqual([
      ["/api/classifieds?filters[id][$eq]=9&populate[images][fields][0]=id", "GET", undefined],
      ["/api/classifieds/9", "PUT", { data: expect.objectContaining({ images: [3, 11, 12], expiresAt: dateInDays(30) }) }],
      ["/api/classifieds/cleanup-uploads", "POST", { imageIds: [4, 5] }],
    ]);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the expiry alone without a picked lifetime, and sweeps nothing when nothing was deselected", async () => {
    fetchMock.mockResolvedValue(uploadAnswers([]));
    await expect(updateClassified(9, {}, form({ keepImages: ["3", "4", "5"] }))).rejects.toThrow("NEXT_REDIRECT");
    const calls = strapiCalls();
    expect(calls.map(([path]) => path)).toEqual([
      "/api/classifieds?filters[id][$eq]=9&populate[images][fields][0]=id",
      "/api/classifieds/9",
    ]);
    expect(calls[1][2]).toEqual({ data: expect.not.objectContaining({ expiresAt: expect.anything() }) });
  });

  it("stops at a form error before reading anything", async () => {
    await expect(updateClassified(9, {}, form({ title: "" }))).resolves.toMatchObject({ error: "missingFields" });
    expect(strapiMock).not.toHaveBeenCalled();
  });

  it("sweeps only the NEW uploads when the PUT fails, never the deselected ones", async () => {
    strapiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path.startsWith("/api/classifieds?")) return { data: [{ images: [{ id: 3 }, { id: 4 }] }] };
      if (init?.method === "PUT") throw cmsError(403);
      return { data: {} };
    });
    await expect(updateClassified(9, {}, form({ images: [image("n.jpg")], keepImages: ["3"] }))).resolves.toMatchObject({
      error: "failed",
    });
    expect(strapiCalls().slice(1)).toEqual([
      ["/api/classifieds/9", "PUT", expect.anything()],
      ["/api/classifieds/cleanup-uploads", "POST", { imageIds: [11, 12] }],
    ]);
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it("treats a failed image lookup as 'no previous images' (janitor territory)", async () => {
    strapiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/classifieds?")) throw cmsError(500);
      return { data: {} };
    });
    await expect(updateClassified(9, {}, form({ keepImages: [] }))).rejects.toThrow("NEXT_REDIRECT");
    expect(strapiCalls().map(([path]) => path)).not.toContain("/api/classifieds/cleanup-uploads");
  });

  it("lets a 401 redirect from the image lookup propagate", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValueOnce(redirectError);
    await expect(updateClassified(9, {}, form())).rejects.toBe(redirectError);
    expect(strapiMock).toHaveBeenCalledTimes(1);
  });

  it("lets a 401 redirect from the PUT propagate, before any sweep", async () => {
    const redirectError = signInRedirect();
    strapiMock.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (init?.method === "PUT") throw redirectError;
      return path.startsWith("/api/classifieds?") ? { data: [{ images: [{ id: 3 }] }] } : { data: {} };
    });
    await expect(updateClassified(9, {}, form({ images: [image("n.jpg")] }))).rejects.toBe(redirectError);
    expect(strapiCalls().map(([path]) => path)).not.toContain("/api/classifieds/cleanup-uploads");
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe("deleteClassified / renewClassified", () => {
  it("deletes by id and refreshes", async () => {
    await expect(deleteClassified(4)).resolves.toEqual({});
    expect(strapiCalls()).toEqual([["/api/classifieds/4", "DELETE", undefined]]);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("renews for the default lifetime and refreshes", async () => {
    await expect(renewClassified(4)).resolves.toEqual({});
    expect(strapiCalls()).toEqual([
      ["/api/classifieds/4", "PUT", { data: { expiresAt: dateInDays(AD_DEFAULT_DURATION_DAYS) } }],
    ]);
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["delete", () => deleteClassified(4)],
    ["renew", () => renewClassified(4)],
  ])("%s answers 'failed' for a 400 and propagates a 401 redirect", async (_label, action) => {
    strapiMock.mockRejectedValueOnce(cmsError(400));
    await expect(action()).resolves.toEqual({ error: "failed" });
    const redirectError = signInRedirect();
    strapiMock.mockRejectedValueOnce(redirectError);
    await expect(action()).rejects.toBe(redirectError);
    expect(refreshMock).not.toHaveBeenCalled();
  });
});
