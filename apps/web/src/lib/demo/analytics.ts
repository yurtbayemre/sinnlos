import type { SearchSummary } from "@/lib/api/analytics";

/** The admin search telemetry (/manage/analytics): 30 days of the demo's searches. */
export const searchLogSummary = {
  windowDays: 30,
  total: 42,
  zeroResultCount: 5,
  topTerms: [
    { term: "vpn", count: 9, avgResults: 3 },
    { term: "expenses", count: 6, avgResults: 2 },
    { term: "onboarding", count: 4, avgResults: 5 },
  ],
  topZeroTerms: [
    { term: "parking", count: 3 },
    { term: "canteen menu", count: 2 },
  ],
} satisfies SearchSummary;
