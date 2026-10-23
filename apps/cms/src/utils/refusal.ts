/**
 * A refusal with its own HTTP status and `details.code` (v0.27 account and
 * second-factor routes). Strapi's error middleware maps an ApplicationError
 * to 400 whatever it says, so the routes that can answer 401/403/409/503
 * run their work through answerRefusals(), which writes Strapi's error
 * envelope with the refusal's own status.
 */
import { errors } from "@strapi/utils";

const NAMES: Record<number, string> = {
  400: "ApplicationError",
  401: "UnauthorizedError",
  403: "ForbiddenError",
  409: "ConflictError",
  503: "ServiceUnavailableError",
};

export class Refusal extends errors.ApplicationError {
  status: number;
  constructor(status: number, code: string, message: string = code) {
    super(message, { code });
    this.status = status;
    (this as { name: string }).name = NAMES[status] ?? "ApplicationError";
  }
}

export function refuse(status: number, code: string, message?: string): never {
  throw new Refusal(status, code, message);
}

interface Answerable {
  status: number;
  body: unknown;
}

/** Runs `work`; a Refusal becomes the answer, anything else goes to Strapi's error middleware. */
export async function answerRefusals(ctx: Answerable, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    if (!(err instanceof Refusal)) throw err;
    ctx.status = err.status;
    ctx.body = {
      data: null,
      error: { status: err.status, name: err.name, message: err.message, details: err.details },
    };
  }
}
