/**
 * Auth.js's error logger (v0.34). A refused sign-in (`CredentialsSignin`:
 * a wrong password, an unknown account, a missing or wrong second factor,
 * the limiter) is an expected answer, not a fault: one short line, without
 * the stack Auth.js's default logger printed for each one, and without the
 * identifier. Every other error is logged as the default logger does
 * (@auth/core lib/utils/logger.js, 0.41): name and message, then the cause
 * with its details, or the stack.
 */
import { AuthError } from "next-auth";

const red = "\x1b[31m";
const reset = "\x1b[0m";

export function logAuthError(error: Error, log: Pick<Console, "error" | "warn"> = console): void {
  const name = error instanceof AuthError ? error.type : error.name;
  if (name === "CredentialsSignin") {
    const code = (error as { code?: unknown }).code;
    log.warn(`[auth] sign-in refused${typeof code === "string" ? ` (${code})` : ""}`);
    return;
  }
  log.error(`${red}[auth][error]${reset} ${name}: ${error.message}`);
  const cause = error.cause;
  if (cause && typeof cause === "object" && "err" in cause && cause.err instanceof Error) {
    const { err, ...data } = cause as { err: Error } & Record<string, unknown>;
    log.error(`${red}[auth][cause]${reset}:`, err.stack);
    if (data) log.error(`${red}[auth][details]${reset}:`, JSON.stringify(data, null, 2));
  } else if (error.stack) {
    log.error(error.stack.replace(/.*/, "").substring(1));
  }
}
