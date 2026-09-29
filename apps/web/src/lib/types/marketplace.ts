/** Marketplace ads (WD01, split from lib/types.ts). */
import type { UserLite } from "./common";

export type ClassifiedCategory =
  | "sale"
  | "giveaway"
  | "wanted"
  | "service-offer"
  | "service-wanted";

export interface ClassifiedImage {
  id: number;
  url?: string;
  name?: string;
  width?: number;
  height?: number;
  formats?: {
    thumbnail?: { url?: string; width?: number; height?: number };
    small?: { url?: string; width?: number; height?: number };
    medium?: { url?: string; width?: number; height?: number };
  } | null;
}

export interface Classified {
  id: number;
  documentId?: string;
  title: string;
  description?: string;
  category?: ClassifiedCategory;
  price?: number | null;
  priceNegotiable?: boolean;
  location?: string | null;
  images?: ClassifiedImage[] | null;
  /** Date (YYYY-MM-DD); ads past this date disappear from the public list. */
  expiresAt?: string;
  author?: UserLite | null;
  createdAt?: string;
}
