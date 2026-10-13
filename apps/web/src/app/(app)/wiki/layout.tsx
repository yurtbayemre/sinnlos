import { ManageFlashProvider } from "@/components/manage/flash";

/**
 * The wiki's pages (batch 16 plan, lane 16C items 5 and 6): the authoring
 * messages of the wiki editor and the history ("Draft saved.", "Version
 * restored and published.") survive the navigation after a create (to the
 * new page's editor) or a delete (to the space), like in /manage. The
 * reading pages render through it unchanged.
 */
export default function WikiLayout({ children }: { children: React.ReactNode }) {
  return <ManageFlashProvider>{children}</ManageFlashProvider>;
}
