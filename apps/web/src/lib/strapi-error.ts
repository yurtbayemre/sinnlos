/**
 * A non-2xx Strapi answer, thrown by strapi() (lib/strapi/client.ts, which
 * re-exports it). The message keeps the historic
 * `Strapi <status> <statusText>: <body>` text; `status` lets a caller map
 * one specific answer — e.g. Strapi's auth throttle 429 to a "too many
 * attempts" message (FX11) — without parsing that text, and `strapiName`
 * / `strapiMessage` carry Strapi's own error envelope
 * (`{ data: null, error: { status, name, message, details } }`), e.g.
 * `ValidationError` / "Already voted" (WD01).
 * Kept in its own module, free of imports, so tests can construct it while
 * mocking strapi().
 */

/** The parts of Strapi's error envelope a caller may branch on. */
export interface StrapiErrorInfo {
  /** `error.name`: `ValidationError`, `ForbiddenError`, `NotFoundError`, … */
  name: string | null;
  /** `error.message`, e.g. "Already voted". */
  message: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/**
 * `error.name` and `error.message` of a Strapi error body, or nulls for
 * anything else (an empty body, HTML from a proxy, plain text, a body
 * without the envelope).
 */
export function parseStrapiError(body: string): StrapiErrorInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { name: null, message: null };
  }
  const error = isRecord(parsed) ? parsed.error : undefined;
  if (!isRecord(error)) return { name: null, message: null };
  return { name: text(error.name), message: text(error.message) };
}

export class StrapiError extends Error {
  readonly status: number;
  /** Strapi's `error.name`, or null when the body is no Strapi error envelope. */
  readonly strapiName: string | null;
  /** Strapi's `error.message`, or null. */
  readonly strapiMessage: string | null;

  constructor(status: number, statusText: string, body: string) {
    super(`Strapi ${status} ${statusText}: ${body}`);
    this.name = "StrapiError";
    this.status = status;
    const info = parseStrapiError(body);
    this.strapiName = info.name;
    this.strapiMessage = info.message;
  }
}
