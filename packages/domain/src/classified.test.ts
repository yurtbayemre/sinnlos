import { describe, expect, it } from "vitest";

import {
  CLASSIFIED_DEFAULT_LIFETIME_DAYS,
  CLASSIFIED_IMAGE_TYPES,
  CLASSIFIED_MAX_IMAGES,
  CLASSIFIED_MAX_IMAGE_BYTES,
  CLASSIFIED_MAX_IMAGE_MB,
  CLASSIFIED_MAX_LIFETIME_DAYS,
} from "./classified.js";

/**
 * The marketplace limits the cms enforces and the web form checks. The
 * values are a contract with running data (ads and their images exist
 * under them): changing one is a product decision, not a refactor.
 */
describe("classified limits", () => {
  it("keeps the numbers both apps used before the package", () => {
    expect(CLASSIFIED_MAX_IMAGES).toBe(4);
    expect(CLASSIFIED_MAX_IMAGE_MB).toBe(5);
    expect(CLASSIFIED_MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024);
    expect(CLASSIFIED_DEFAULT_LIFETIME_DAYS).toBe(30);
    expect(CLASSIFIED_MAX_LIFETIME_DAYS).toBe(90);
  });

  it("allows only JPEG, PNG and WebP: no SVG, no GIF", () => {
    expect([...CLASSIFIED_IMAGE_TYPES]).toEqual(["image/jpeg", "image/png", "image/webp"]);
  });

  it("defaults to a lifetime within the clamp", () => {
    expect(CLASSIFIED_DEFAULT_LIFETIME_DAYS).toBeGreaterThan(0);
    expect(CLASSIFIED_DEFAULT_LIFETIME_DAYS).toBeLessThanOrEqual(CLASSIFIED_MAX_LIFETIME_DAYS);
  });
});
