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
