import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function initials(name: string | undefined | null): string {
  if (!name) return "?";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

/** Strip HTML tags from Strapi richtext for plain-text previews. */
export function stripHtml(s?: string | null): string {
  if (!s) return "";
  return s.replace(/<[^>]*>?/gm, "");
}

/**
 * Validate a user-supplied redirect target (e.g. the ?from= param the
 * route guard appends to /sign-in). Only same-origin absolute paths are
 * allowed — external URLs, protocol-relative "//host" and backslash
 * variants fall back to `fallback` to avoid open redirects. Auth pages
 * are excluded so a stale ?from can't bounce users back to the form.
 */
export function safeInternalPath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (value === "/sign-in" || value.startsWith("/sign-in?")) return fallback;
  if (value === "/register" || value.startsWith("/register?")) return fallback;
  return value;
}
