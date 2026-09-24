/**
 * A non-2xx Strapi answer, thrown by strapi() (lib/strapi.ts). The message
 * keeps the historic `Strapi <status> <statusText>: <body>` text; `status`
 * lets a caller map one specific answer — e.g. Strapi's auth throttle 429 to
 * a "too many attempts" message (FX11) — without parsing that text.
 * Kept in its own module so tests can construct it while mocking strapi().
 */
export class StrapiError extends Error {
  readonly status: number;

  constructor(status: number, statusText: string, body: string) {
    super(`Strapi ${status} ${statusText}: ${body}`);
    this.name = "StrapiError";
    this.status = status;
  }
}
