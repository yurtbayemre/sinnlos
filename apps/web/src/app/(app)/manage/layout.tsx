import { ManageFlashProvider } from "@/components/manage/flash";
import { manageGate } from "@/lib/manage/page-gate";

/**
 * The /manage shell (deep-dive decision 06 §L1; batch 15 plan, lane 15C
 * item 1): every page below needs `capabilities.manage` (SH02), read per
 * request from the viewer's role; without it the shell redirects home.
 * Each area page gates itself further on `author[area]`, and the reports
 * on `reports.*` (admin only).
 *
 * The flash provider keeps the authoring messages ("Draft saved.") across
 * the navigation after a create or a delete.
 */
export default async function ManageLayout({ children }: { children: React.ReactNode }) {
  await manageGate();
  return <ManageFlashProvider>{children}</ManageFlashProvider>;
}
